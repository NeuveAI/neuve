import { preserveUnknown, safeRead } from "@neuve/records-schema";
import type { AuthorityCloseFailure } from "./pi/capture/authority-close.ts";
import { readLegacyReceiptCapture } from "./pi/capture/export.ts";
import { readRawManifest } from "./pi/capture/raw.ts";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { PrivateInspection } from "./pi/capture/private-inspection.ts";
import {
  credentialGuards,
  openManagedCredentialInspection,
  privateInspectionDirectory,
} from "./pi/capture/safety.ts";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { openNativeStorage } from "./pi/storage.ts";
import { Data, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import { Range, JobRow } from "@neuve/records-schema";
import {
  Blobs,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
} from "@neuve/records-core";
import { SourceOwned, SourceOwnership } from "./pi/source-ownership.ts";
import type { NativeReads } from "./pi/capture/build.ts";
import {
  receiptOf,
  type CloseInput,
  type CloseMode,
  type CloseReceipt,
} from "./pi/capture/close.ts";
import type { BackupStatus, PriceRate } from "./pi/capture/dump.ts";
import { captureRunDump } from "./pi/capture/export.ts";
import {
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
  captureFileIdentity,
  journalIdentity,
  type CaptureJournal,
} from "./pi/capture/journal.ts";
import { captureFileLimit, DEFAULT_LIMITS } from "./pi/capture/types.ts";

/**
 * A run's folder, `.git/neuve/runs/<run-id>/` (10.14, proposal §1): beside Records' local state and
 * outside the working tree, invisible to agents, whose tools read only git objects (2.16). It holds
 * pi's database (`pi.sqlite` with its sidecars) and the capture journal (`capture/`). The whole
 * folder is deleted when the run ends and when
 * its job fails for the last time, after its pi state is captured (record 0004), and when it is
 * abandoned (a dropped job, a newer pipeline version, or past 30 days), keeping nothing.
 */

export const runsDirectory = (location: StoreLocation) =>
  join(location.directory, "runs");

export const runFolder = (location: StoreLocation, runId: string) =>
  join(runsDirectory(location), runId);

const withSource = <A, E, R>(
  location: StoreLocation,
  runId: string,
  ownership: SourceOwnership | undefined,
  work: (owner: SourceOwnership) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = runFolder(location, runId);
      const owner =
        ownership ??
        (yield* Effect.acquireRelease(
          Effect.try({
            try: () => SourceOwnership.acquire(source),
            catch: (error) => error,
          }),
          (owner) => Effect.sync(() => owner.release()),
        ));
      yield* Effect.try({
        try: () => owner.assertDisposable(source),
        catch: (error) => error,
      });
      return yield* work(owner);
    }),
  );

/** pi's native database for a review run (record 0004); its WAL sidecars sit beside it. */
export const PI_DATABASE = "pi.sqlite";

export const piDatabase = (location: StoreLocation, runId: string) =>
  join(runFolder(location, runId), PI_DATABASE);

/** The run's capture journal (pi/capture/journal.ts), read into the session dump before the folder goes. */
export const captureFolder = (location: StoreLocation, runId: string) =>
  join(runFolder(location, runId), "capture");

/** What the folder says about its run, so abandonment can be decided without the job. */
export const RunManifest = z.strictObject({
  runId: z.string().min(1),
  runKey: z.string().min(1),
  pipelineVersion: z.int().min(1),
  range: Range,
  jobSeq: z.int().min(1),
});
export type RunManifest = z.infer<typeof RunManifest>;

const manifestPath = (location: StoreLocation, runId: string) =>
  join(runFolder(location, runId), "run.json");

/** Creates the folder, owner-only like the rest of the store, and records its manifest. */
export const ensureRunFolder = (
  location: StoreLocation,
  manifest: RunManifest,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const folder = runFolder(location, manifest.runId);
    yield* fs.makeDirectory(folder, {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
    yield* fs.chmod(folder, STORE_DIRECTORY_MODE);
    const path = manifestPath(location, manifest.runId);
    const next = yield* fs.exists(path).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(path).pipe(
              Effect.flatMap((raw) =>
                Effect.try(() =>
                  preserveUnknown(RunManifest, JSON.parse(raw), manifest, {
                    source: manifestPath(location, manifest.runId),
                  }),
                ),
              ),
            )
          : Effect.succeed(RunManifest.parse(manifest)),
      ),
    );
    yield* fs.writeFileString(path, `${JSON.stringify(next)}\n`, {
      mode: STORE_FILE_MODE,
    });
    return folder;
  });

export const runFolderExists = (location: StoreLocation, runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* fs.exists(runFolder(location, runId));
  });

/** Every run folder with its manifest, or none where the manifest is missing or unreadable. */
export const listRunFolders = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const root = runsDirectory(location);
    if (!(yield* fs.exists(root))) return [];
    const names = yield* fs.readDirectory(root);
    return yield* Effect.forEach(names, (runId) =>
      Effect.gen(function* () {
        const text = yield* fs
          .readFileString(manifestPath(location, runId))
          .pipe(Effect.option);
        let compatible = false;
        const manifest = Option.flatMap(text, (raw) => {
          try {
            const parsed = safeRead(RunManifest, JSON.parse(raw), {
              source: manifestPath(location, runId),
            });
            if (parsed.success) compatible = parsed.droppedKeys.length > 0;
            return parsed.success ? Option.some(parsed.data) : Option.none();
          } catch {
            return Option.none();
          }
        });
        return { runId, manifest, compatible };
      }),
    );
  });

/** pi's storage as the capture opens it: its reads, and the close that releases the file. */
export type NativeStorage = NativeReads & Pick<Storage, "close">;

/** Opens a run's pi database for the capture; the default is pi's own SQLite storage. */
export type OpenNativeStorage = (path: string) => Promise<NativeStorage>;

export class NativeStorageFailed extends Data.TaggedError(
  "NativeStorageFailed",
)<{
  readonly path: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * A close or a receipt that cannot stand for the run's state: another run's, a held or interrupted
 * close's, or a capture its folder has moved on from.
 */
export class ReceiptMismatch extends Data.TaggedError("ReceiptMismatch")<{
  readonly runId: string;
  readonly reason: string;
}> {}

export interface CaptureOptions {
  readonly authorityFailure?: AuthorityCloseFailure | undefined;
  readonly credentialInspection?: PrivateInspection | undefined;
  /** A named rate for the dump's estimates. */
  readonly rate?: PriceRate | undefined;
  /** Identifiers fetched sources declare, masked with the rest. */
  readonly declared?: ReadonlyArray<string> | undefined;
  /** How long the capture's reads may take; the close's own context may be aborted, so it gets a fresh one. */
  readonly timeoutMs?: number | undefined;
}

export interface RemoveOptions extends CaptureOptions {
  readonly ownership?: SourceOwnership | undefined;
  /** The receipt of this run's close, handed over only after capture and pi storage close succeed. */
  readonly receipt?: CloseReceipt | undefined;
  readonly openNative?: OpenNativeStorage | undefined;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;

/** A context no caller's abort reaches, bounded so a capture that hangs still ends. */
const captureContext = (options: CaptureOptions) =>
  withAbortSignal(
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS),
    BACKGROUND_CONTEXT,
  );

const nativeFailure = (path: string) => (error: unknown) =>
  new NativeStorageFailed({
    path,
    cause: error,
    reason: error instanceof Error ? error.message : String(error),
  });

/**
 * The run's restricted capture into Records, from pi's open storage, its database file and the
 * journal, taken at a close of `mode`, which the capture records; its receipt.
 */
const captureRun = (
  location: StoreLocation,
  runId: string,
  reads: NativeReads | undefined,
  options: CaptureOptions,
  mode: CloseMode,
) =>
  Effect.map(
    captureRunDump({
      runId,
      journal: captureFolder(location, runId),
      credentialInspection: options.credentialInspection,
      authorityFailure: options.authorityFailure,
      native:
        reads === undefined
          ? undefined
          : { reads, context: captureContext(options) },
      nativeDatabase: existsSync(piDatabase(location, runId))
        ? piDatabase(location, runId)
        : undefined,
      rate: options.rate,
      declared: options.declared,
      close: mode,
    }),
    (captured) => receiptOf(mode, captured),
  );

/**
 * The capture at the raw `Storage.close` of a run's pi harness (record 0004). The runtime calls it
 * once the Session is sealed and its scheduler joined, with the raw storage still open, and closes
 * the real database after it. It ends this process's journal session first: every callback has
 * joined, so nothing more can be captured, and the close mark says only that capture stayed
 * healthy, never that the run ended. A journal that already failed is left unclosed; its failure
 * reached the run when it happened, and the dump discloses it from disk. Pending tasks stay pending
 * and nothing is written to pi.
 */
export const exportOnClose =
  (
    options: CaptureOptions & {
      readonly location: StoreLocation;
      readonly runId: string;
      readonly journal?: CaptureJournal | undefined;
    },
  ) =>
  (input: CloseInput) =>
    Effect.gen(function* () {
      if (input.runId !== options.runId)
        return yield* new ReceiptMismatch({
          runId: options.runId,
          reason: `closing run ${input.runId}`,
        });
      try {
        options.journal?.close();
      } catch {}
      return yield* captureRun(
        options.location,
        options.runId,
        input.reads,
        options,
        input.mode,
      );
    });

export type ExportOnClose = ReturnType<typeof exportOnClose>;

/**
 * Captures a closed run's pi state into a restricted raw capture (record 0004): pi's database,
 * reopened through its own storage, read, copied whole and closed again, joined with the capture
 * journal and its artifacts. None when the folder holds neither, as on a run of the earlier
 * pipeline. A close that fails fails the capture too, so the folder is never removed after it.
 */
export const captureNativeRun = (
  location: StoreLocation,
  runId: string,
  options: RemoveOptions = {},
) =>
  withSource(location, runId, options.ownership, (ownership) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const database = piDatabase(location, runId);
      const hasDatabase = yield* fs.exists(database);
      if (
        !hasDatabase &&
        !(yield* fs.exists(join(captureFolder(location, runId), JOURNAL_FILE)))
      )
        return Option.none();
      let authority = options.credentialInspection;
      let opened = false;
      let authorityFailure = options.authorityFailure;
      const directory = privateInspectionDirectory(
        runFolder(location, runId),
        location.directory,
      );
      if (authority === undefined && existsSync(directory)) {
        authority = yield* Effect.try({
          try: () =>
            PrivateInspection.open({
              ownership,
              source: runFolder(location, runId),
              directory,
              excludedRoots: [runsDirectory(location), tmpdir()],
            }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              authorityFailure = { cause: error };
              return undefined;
            }),
          ),
        );
        opened = authority !== undefined;
      }
      const capture = Effect.gen(function* () {
        if (!hasDatabase)
          return yield* captureRun(
            location,
            runId,
            undefined,
            { ...options, credentialInspection: authority, authorityFailure },
            "ended",
          );
        const native = yield* Effect.tryPromise({
          try: () =>
            ownership.openNative(
              database,
              options.openNative ?? openNativeStorage,
            ),
          catch: (error) =>
            error instanceof SourceOwned
              ? error
              : nativeFailure(database)(error),
        });
        return yield* captureRun(
          location,
          runId,
          native,
          { ...options, credentialInspection: authority, authorityFailure },
          "ended",
        ).pipe(
          Effect.onExit(() =>
            Effect.tryPromise({
              try: () => native.close(BACKGROUND_CONTEXT),
              catch: nativeFailure(database),
            }),
          ),
        );
      });
      return yield* capture.pipe(
        Effect.map(Option.some),
        Effect.ensuring(
          Effect.sync(() => {
            if (opened) authority?.close();
          }),
        ),
      );
    }).pipe(Effect.uninterruptible),
  );

/** Deletes the run folder and everything in it, keeping nothing (abandonment). */
export const deleteRunFolder = (
  location: StoreLocation,
  runId: string,
  ownership?: SourceOwnership,
  options: { readonly retentionExpired?: boolean } = {},
) =>
  withSource(location, runId, ownership, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const folder = runFolder(location, runId);
      if (!(yield* fs.exists(folder))) return { removed: false };
      if (
        !options.retentionExpired &&
        (yield* fs.exists(manifestPath(location, runId)))
      ) {
        const raw = yield* fs.readFileString(manifestPath(location, runId));
        const read = yield* Effect.try(() =>
          safeRead(RunManifest, JSON.parse(raw), {
            source: manifestPath(location, runId),
          }),
        );
        if (!read.success || read.droppedKeys.length > 0)
          return { removed: false };
        const sql = yield* Effect.serviceOption(SqlClient);
        if (Option.isNone(sql)) return { removed: false };
        const [job] =
          yield* sql.value`SELECT * FROM jobs WHERE job_seq=${read.data.jobSeq}`;
        if (job !== undefined) {
          const held = safeRead(JobRow, job);
          if (!held.success || held.droppedKeys.length > 0)
            return { removed: false };
        }
      }
      yield* fs.remove(folder, { recursive: true, force: true });
      return { removed: true };
    }),
  );

/** Check folder contents without reading or opening pi's closed database. */
const verifyNativeFiles = async (database: string, backup: BackupStatus) => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const info = await lstat(database + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (
      suffix === "" &&
      (info !== undefined) !== (backup.status === "captured")
    )
      throw new Error("native database presence changed after capture");
    if (info === undefined) continue;
    if (info.size > DEFAULT_LIMITS.objectBytes)
      throw new Error("native source exceeds the object limit");
    if (!info.isFile() || info.nlink !== 1 || backup.status !== "captured")
      throw new Error("uncaptured or aliased native source");
  }
};

/**
 * Verify the capture in Records, its ended lifecycle and the unchanged journal under source ownership.
 * Pi's Session was sealed and its scheduler joined before capture, and its storage closed before the
 * receipt was handed back. No cooperating writer can change pi state after that copy. A later claim
 * appends to the journal before doing pi work, invalidating this receipt. This also holds for legacy
 * receipts, whose close used the same barrier, so removal never opens their closed database either.
 * A held or interrupted close, or an ended close with work still in flight, cannot authorize removal.
 */
const verifiedReceipt = (
  location: StoreLocation,
  runId: string,
  receipt: CloseReceipt,
) =>
  Effect.gen(function* () {
    const mismatch = (reason: string) =>
      Effect.fail(new ReceiptMismatch({ runId, reason }));
    if (receipt.runId !== runId)
      return yield* mismatch(`the receipt is run ${receipt.runId}'s`);
    if (receipt.snapshotId !== receipt.capture)
      return yield* mismatch("the receipt's snapshot is not its capture");
    if (receipt.mode !== "ended")
      return yield* mismatch(`the receipt is a ${receipt.mode} close's`);
    if (receipt.pendingScan === true) {
      const held = { manifest: yield* readRawManifest(receipt.capture) };
      if (held.manifest.runId !== runId)
        return yield* mismatch(
          `capture ${receipt.capture} is run ${held.manifest.runId}'s`,
        );
      if (held.manifest.close !== "ended")
        return yield* mismatch(
          `capture ${receipt.capture} was taken at a ${held.manifest.close} close`,
        );
      if (!held.manifest.lifecycle.runEnded)
        return yield* mismatch(
          `capture ${receipt.capture} has no run.end: the run's execution is open`,
        );
      if (held.manifest.lifecycle.workInFlight)
        return yield* mismatch(
          `capture ${receipt.capture} holds pi work still in flight`,
        );
      const blobs = yield* Blobs.BlobStore;
      for (const file of held.manifest.files) {
        if (file.size > captureFileLimit(file.name, DEFAULT_LIMITS))
          return yield* mismatch("raw capture exceeds its object byte cap");
        const metadata = yield* blobs.inspect(file.sha256);
        if (
          Option.isNone(metadata) ||
          metadata.value.size !== file.size ||
          metadata.value.prunedAt !== null
        )
          return yield* mismatch("raw capture file is unavailable");
        const verified = yield* blobs.get(file.sha256);
        if (verified._tag !== "Present")
          return yield* mismatch("raw capture file was pruned");
      }
      for (const file of held.manifest.files.filter((file) =>
        file.name.startsWith(`capture/${OBJECTS_DIRECTORY}/`),
      )) {
        const current = yield* Effect.tryPromise({
          try: () =>
            captureFileIdentity(join(runFolder(location, runId), file.name)),
          catch: () =>
            new ReceiptMismatch({
              runId,
              reason: "raw journal file unavailable",
            }),
        });
        if (current?.size !== file.size || current.sha256 !== file.sha256)
          return yield* mismatch(
            `the run's capture journal changed after capture ${receipt.capture}`,
          );
      }
      const journal = yield* Effect.tryPromise(() =>
        journalIdentity(captureFolder(location, runId)),
      );
      const captured = held.manifest.files.find(
        (file) => file.name === `capture/${JOURNAL_FILE}`,
      );
      if (
        captured === undefined
          ? journal !== undefined
          : journal?.sha256 !== captured.sha256 ||
            journal.size !== captured.size
      )
        return yield* mismatch(
          `the run's capture journal changed after capture ${receipt.capture}`,
        );
      yield* Effect.tryPromise({
        try: () =>
          verifyNativeFiles(piDatabase(location, runId), held.manifest.backup),
        catch: () =>
          new ReceiptMismatch({
            runId,
            reason: "the native source cannot be verified",
          }),
      });
      return receipt;
    }
    const held = yield* readLegacyReceiptCapture(receipt.capture);
    if (held.run.runId !== runId)
      return yield* mismatch(
        `capture ${receipt.capture} is run ${held.run.runId}'s`,
      );
    if (held.run.close !== "ended")
      return yield* mismatch(
        `capture ${receipt.capture} was taken at ${held.run.close === null ? "no close" : `a ${held.run.close} close`}`,
      );
    if (held.run.execution !== "ended")
      return yield* mismatch(
        `capture ${receipt.capture} has no run.end: the run's execution is open`,
      );
    if (held.run.gaps.some((gap) => gap.code === "work-in-flight"))
      return yield* mismatch(
        `capture ${receipt.capture} holds pi work still in flight`,
      );
    const journal = yield* Effect.tryPromise({
      try: () => journalIdentity(captureFolder(location, runId)),
      catch: (error) =>
        new ReceiptMismatch({
          runId,
          reason: `the capture journal cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    const captured = held.run.journal;
    const same =
      captured.status === "captured"
        ? journal?.sha256 === captured.sha256 && journal.size === captured.size
        : journal === undefined;
    if (!same)
      return yield* mismatch(
        `the run's capture journal changed after capture ${receipt.capture}`,
      );
    if (captured.status === "captured")
      for (const object of captured.objects ?? []) {
        const current = yield* Effect.tryPromise({
          try: () =>
            captureFileIdentity(
              join(
                captureFolder(location, runId),
                OBJECTS_DIRECTORY,
                object.sha256,
              ),
            ),
          catch: () =>
            new ReceiptMismatch({
              runId,
              reason: "raw journal object unavailable",
            }),
        });
        if (current?.size !== object.size || current.sha256 !== object.sha256)
          return yield* mismatch("a journal object changed after capture");
      }
    yield* Effect.tryPromise({
      try: () =>
        verifyNativeFiles(piDatabase(location, runId), held.run.backup),
      catch: () =>
        new ReceiptMismatch({
          runId,
          reason: "the native source cannot be verified",
        }),
    });
    return receipt;
  });

/**
 * Deletes the run folder at the end of the run or on its final failure, after its pi state is captured: by the ended close's receipt it is given,
 * checked against Records and the folder, or by reopening pi's database when there is none (the
 * ended-run sweep). A capture, a readback, a close or a receipt that fails leaves the folder in
 * place, so its database is never deleted uncaptured or behind a stale capture; the folder then
 * waits for explicit abandonment or the 30-day sweep. `captures` holds the native session dump's
 * hash when there is one; `dump` is the receipt it went with.
 */
export const removeRunFolder = (
  location: StoreLocation,
  runId: string,
  options: RemoveOptions = {},
) =>
  withSource(location, runId, options.ownership, (ownership) =>
    Effect.gen(function* () {
      const dump =
        options.receipt === undefined
          ? yield* captureNativeRun(location, runId, { ...options, ownership })
          : Option.some(
              yield* verifiedReceipt(location, runId, options.receipt),
            );
      const { removed } = yield* deleteRunFolder(location, runId, ownership);
      return {
        removed,
        captures: Option.match(dump, {
          onNone: () => [],
          onSome: ({ capture }) => [capture],
        }),
        dump,
      };
    }),
  );
