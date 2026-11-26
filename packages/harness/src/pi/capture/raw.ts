import { readData } from "@neuve/records-core";
import { createCaptureStaging } from "./staging.ts";
import {
  authorityCloseRefusal,
  clearAuthorityCloseFailures,
} from "./authority-close.ts";
import * as CaptureRecords from "./records.ts";
import { NativeAuthorityReceipt } from "./private-inspection.ts";
import {
  lstat,
  readdir,
  open,
  realpath,
  mkdir,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import { measuredCloseInventory } from "./inventory.ts";
import { dirname, join } from "node:path";
import { Effect, Data, Clock } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  Blobs,
  Log,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import { nativeBackup, type BuildInput, DumpFailed } from "./build.ts";
import { BackupStatus, CloseMode, PriceRate } from "./dump.ts";
import {
  CAPTURE_LOSS_FILE,
  captureFileLimit,
  DEFAULT_LIMITS,
  type DumpLimits,
} from "./types.ts";
import {
  sha256Of,
  decodeCaptureLosses,
  readCaptureJournal,
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
} from "./journal.ts";
import { CloseInventory, checkedCount } from "./watchdog.ts";
import { PrivateInspection } from "./private-inspection.ts";

export class RawCapturePruned extends Data.TaggedError("RawCapturePruned")<{
  readonly reason: string;
}> {
  readonly retryable = false;
  override get message() {
    return this.reason;
  }
}
export const RAW_CAPTURE_MEDIA_TYPE = "application/vnd.neuve.raw-capture+json";
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const RawFile = z.strictObject({
  name: z
    .string()
    .regex(
      /^(?:capture\/(?:events\.jsonl|capture-loss\.json|objects\/[a-f0-9]{64}(?:\.original)?)|native\/pi\.sqlite)$/,
    ),
  sha256: Hash,
  size: z.int().nonnegative(),
  mediaType: z.string(),
});
export const RawCapture = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  close: CloseMode.nullable(),
  source: z.string(),
  checkpoint: NativeAuthorityReceipt.nullable(),
  counts: CloseInventory,
  lifecycle: z.strictObject({
    runEnded: z.boolean(),
    workInFlight: z.boolean(),
  }),
  unscannable: z.string().nullable(),
  rate: PriceRate.nullable(),
  declared: z.array(z.string()),
  backup: BackupStatus,
  files: z.array(RawFile),
});
export type RawCapture = z.infer<typeof RawCapture>;
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

export const captureStoreLocation = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{
    file: string;
  }>`SELECT file FROM pragma_database_list WHERE name='main'`;
  if (row === undefined || row.file.length === 0)
    return yield* Effect.fail(
      new Error("capture requires a file-backed Records store"),
    );
  return storeLocationIn(dirname(dirname(row.file)));
});

/** No census or source inspection belongs here. Only frozen native/journal bytes are filed. */
export const fileRawCapture = (input: BuildInput) =>
  Effect.gen(function* () {
    input.signal?.throwIfAborted();
    const limits = input.limits ?? DEFAULT_LIMITS;
    const backup = awaitBackup(input, limits);
    const native = yield* Effect.tryPromise({
      try: () => backup,
      catch: (error) => error,
    });
    const contents: z.infer<typeof RawFile>[] = [];
    const blobs = yield* Blobs.BlobStore;
    let total = 0;
    let largest = 0;
    const add = (name: string, bytes: Uint8Array, mediaType: string) =>
      Effect.gen(function* () {
        input.signal?.throwIfAborted();
        yield* Effect.try({
          try: () => {
            RawFile.shape.name.parse(name);
            const limit = captureFileLimit(name, limits);
            if (bytes.byteLength > limit)
              throw new DumpFailed({
                reason: `capture content is ${bytes.byteLength} bytes, over the ${limit}-byte object limit`,
              });
            total = checkedCount(total, bytes.byteLength);
            largest = Math.max(largest, bytes.byteLength);
            if (total > limits.totalBytes)
              throw new DumpFailed({
                reason: `the dump is ${total} bytes, over the ${limits.totalBytes}-byte limit`,
              });
          },
          catch: (error) => error,
        });
        const stored = yield* blobs.put({
          bytes,
          mediaType,
          retention: "raw-capture",
        });
        input.progress?.();
        const verified = yield* blobs.get(stored.blob.hash);
        if (verified._tag !== "Present")
          return yield* Effect.fail(
            new RawCapturePruned({
              reason: `raw capture pruned on ${verified.blob.prunedAt}`,
            }),
          );
        contents.push({
          name,
          mediaType,
          sha256: stored.blob.hash,
          size: bytes.byteLength,
        });
        input.progress?.();
      });
    const names = yield* Effect.tryPromise({
      try: async () => {
        const names: string[] = [];
        for (const name of [JOURNAL_FILE, CAPTURE_LOSS_FILE]) {
          if (
            await lstat(join(input.journal, name)).catch((error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return undefined;
              throw error;
            })
          )
            names.push(name);
        }
        const objects = join(input.journal, OBJECTS_DIRECTORY);
        const info = await lstat(objects).catch(() => undefined);
        if (info !== undefined) {
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("raw capture objects is not a directory");
          for (const name of (await readdir(objects)).toSorted())
            names.push(`${OBJECTS_DIRECTORY}/${name}`);
        }
        return names;
      },
      catch: (error) => error,
    });
    let losses: ReturnType<typeof decodeCaptureLosses> = [];
    for (const name of names) {
      const bytes = yield* Effect.tryPromise({
        try: async () => {
          input.signal?.throwIfAborted();
          RawFile.shape.name.parse(`capture/${name}`);
          const path = join(input.journal, name);
          const info = await lstat(path);
          if (!info.isFile() || info.nlink !== 1)
            throw new Error(
              "raw capture requires unaliased regular journal files",
            );
          const limit = captureFileLimit(name, limits);
          if (info.size > limit)
            throw new DumpFailed({
              reason: `capture content is ${info.size} bytes, over the ${limit}-byte object limit`,
            });
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const opened = await file.stat();
            if (opened.dev !== info.dev || opened.ino !== info.ino)
              throw new Error("raw capture file changed");
            const bytes = new Uint8Array(await file.readFile());
            const after = await file.stat();
            if (
              after.size !== info.size ||
              bytes.byteLength !== info.size ||
              after.mtimeMs !== info.mtimeMs
            )
              throw new Error("raw capture file changed");
            return bytes;
          } finally {
            await file.close();
          }
        },
        catch: (error) => error,
      });
      if (name === CAPTURE_LOSS_FILE)
        losses = yield* Effect.try(() => decodeCaptureLosses(bytes));
      yield* add(`capture/${name}`, bytes, "application/octet-stream");
    }
    if (native.bytes !== undefined)
      yield* add("native/pi.sqlite", native.bytes, "application/vnd.sqlite3");
    const canonicalSource = yield* Effect.tryPromise(() =>
      realpath(dirname(input.journal)),
    );
    const location = yield* captureStoreLocation;
    const journal = readCaptureJournal(input.journal, limits);
    const lines = journal._tag === "Read" ? journal.lines : [];
    const stored = new Map(contents.map((file) => [file.name, file]));
    const journalFile = stored.get(`capture/${JOURNAL_FILE}`);
    if (
      journal._tag === "Read" &&
      (journalFile?.sha256 !==
        (journal.bytes === null ? undefined : sha256Of(journal.bytes)) ||
        [...journal.objects].some(([hash, { bytes }]) => {
          const file = stored.get(`capture/${OBJECTS_DIRECTORY}/${hash}`);
          return file?.sha256 !== hash || file.size !== bytes.byteLength;
        }))
    )
      return yield* Effect.fail(new Error("raw journal changed during filing"));
    const captureBytes = contents.reduce(
      (total, file) =>
        file.name.startsWith("capture/")
          ? checkedCount(total, file.size)
          : total,
      0,
    );
    const counts = measuredCloseInventory(
      lines,
      checkedCount(captureBytes, native.bytes?.byteLength ?? 0),
      native.metadata?.records ?? 0,
      losses,
    );
    const sql = yield* SqlClient;
    // The state of this run defines a filing. The checkpoint's random storage identity does not.
    const filingKey = `capture.filed:${sha256Of(encode({ runId: input.runId, source: canonicalSource, files: contents, counts, backup: native.status, close: input.close ?? null, rate: input.rate ?? null, declared: input.declared ?? [], authority: input.credentialInspection !== undefined || input.authorityFailure !== undefined }))}`;
    const existing = Effect.gen(function* () {
      const [row] = yield* sql<{
        rawCapture: string;
      }>`SELECT json_extract(envelope,'$.payload.rawCapture') AS raw_capture FROM events WHERE idempotency_key=${filingKey} AND kind='capture.filed@1'`;
      if (row === undefined) return undefined;
      const manifest = yield* readRawManifest(row.rawCapture, limits);
      return { rawCapture: row.rawCapture, manifest };
    });
    const clearFailures = Effect.try(() =>
      clearAuthorityCloseFailures(canonicalSource),
    ).pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "capture authority retry state cleanup failed; the next close will retry",
        ),
      ),
    );
    const prior = yield* existing;
    if (prior !== undefined) {
      yield* clearFailures;
      return prior;
    }
    let checkpoint: NativeAuthorityReceipt | null = null;
    const authorityFailure = input.authorityFailure;
    let unscannable: string | null =
      authorityFailure === undefined
        ? null
        : yield* Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.try({
              try: () =>
                authorityCloseRefusal(
                  canonicalSource,
                  filingKey,
                  authorityFailure.cause,
                  now,
                ),
              catch: (error) => error,
            }),
          );
    const hasCaptureLoss = losses.length > 0;
    const needsInspection = lines.some(
      ({ event }) =>
        event.type === "credential.registration" ||
        event.type === "credential.guard",
    );
    if (
      input.credentialInspection !== undefined &&
      native.bytes !== undefined &&
      native.status.status === "captured" &&
      journal._tag === "Read" &&
      journal.bytes !== null
    ) {
      const authority = input.credentialInspection;
      const nativeBytes = native.bytes;
      const nativeSha256 = native.status.sha256;
      const journalSha256 = sha256Of(journal.bytes);
      checkpoint = yield* Effect.tryPromise({
        try: async () => {
          const root = join(location.directory, "capture-authorities");
          await mkdir(root, { recursive: true, mode: 0o700 });
          const staging = createCaptureStaging(
            join(location.directory, ".capture-checkpoint-"),
          );
          let receipt: NativeAuthorityReceipt | undefined;
          let moved = false;
          let durable = false;
          try {
            const path = join(staging, "native.sqlite");
            await writeFile(path, nativeBytes, { mode: 0o600, flag: "wx" });
            receipt = await authority.snapshotForNative({
              nativeDatabase: path,
              nativeSha256,
              runId: input.runId,
              journal: await realpath(input.journal),
              rawJournalSha256: journalSha256,
            });
            await rename(
              authority.checkpointDirectory(receipt),
              join(root, receipt.id),
            );
            moved = true;
            const directory = await open(root, "r");
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
            durable = true;
            return receipt;
          } finally {
            if (receipt !== undefined && !durable)
              await rm(
                moved
                  ? join(root, receipt.id)
                  : authority.checkpointDirectory(receipt),
                {
                  recursive: true,
                  force: true,
                },
              );
            await rm(staging, { recursive: true, force: true });
          }
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          return Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.try({
              try: () => {
                unscannable = authorityCloseRefusal(
                  canonicalSource,
                  filingKey,
                  error,
                  now,
                );
                return null;
              },
              catch: (failure) => failure,
            }),
          );
        }),
      );
    } else if (needsInspection && !hasCaptureLoss)
      unscannable =
        native.bytes === undefined
          ? "credential inspection requires an exact native backup; source retained privately, export refused"
          : "historical credential authority is unavailable; source retained privately, export refused";
    const manifest = RawCapture.parse({
      version: 1,
      runId: input.runId,
      source: canonicalSource,
      checkpoint,
      counts,
      lifecycle: {
        runEnded: lines.some(({ event }) => event.type === "run.end"),
        workInFlight:
          native.metadata?.workInFlight ?? native.bytes !== undefined,
      },
      unscannable,
      close: input.close ?? null,
      rate: input.rate ?? null,
      declared: input.declared ?? [],
      backup: native.status,
      files: contents,
    });
    input.signal?.throwIfAborted();
    const bytes = encode(manifest);
    if (bytes.byteLength > limits.manifestBytes)
      return yield* Effect.fail(
        new Error("raw capture manifest exceeds its size limit"),
      );
    const rawCapture = sha256Of(bytes);
    yield* blobs.put({
      bytes,
      mediaType: RAW_CAPTURE_MEDIA_TYPE,
      retention: "raw-capture",
    });
    input.progress?.();
    const filed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* existing;
        if (prior !== undefined) return prior;
        const hashes = [
          rawCapture,
          ...manifest.files.map((file) => file.sha256),
        ];
        for (let i = 0; i < hashes.length; i += 128) {
          const batch = hashes.slice(i, i + 128);
          const rows = yield* sql<{
            hash: string;
          }>`SELECT hash FROM blobs WHERE ${sql.in("hash", batch)} AND pruned_at IS NULL`;
          if (new Set(rows.map((row) => row.hash)).size !== new Set(batch).size)
            return yield* Effect.fail(
              new Error("raw capture blob unavailable before filing"),
            );
          if (journal._tag === "Read" && journal.objects.size > 0) {
            const parts = batch.filter(
              (hash) =>
                hash !== rawCapture &&
                (hash === journalFile?.sha256 || journal.objects.has(hash)),
            );
            if (parts.length > 0)
              yield* sql`INSERT OR IGNORE INTO raw_capture_parts ${sql.insert(parts.map((part_hash) => ({ capture_hash: rawCapture, part_hash })))}`;
          }
        }
        yield* Log.append([
          {
            ...CaptureRecords.captureFiledEvent({
              rawCapture,
              runId: input.runId,
              counts,
              checkpoint,
              sizes: { total, largest },
            }),
            idempotencyKey: filingKey,
          },
        ]);
        return { rawCapture, manifest };
      }),
    );
    if (filed.rawCapture !== rawCapture && checkpoint !== null) {
      const redundant = checkpoint;
      yield* Effect.tryPromise(() =>
        rm(join(location.directory, "capture-authorities", redundant.id), {
          recursive: true,
          force: true,
        }),
      );
    }
    yield* clearFailures;
    return filed;
  });

const awaitBackup = (input: BuildInput, limits: DumpLimits) =>
  Promise.resolve().then(
    () =>
      input.native?.reads.captureBackup?.(limits.objectBytes) ??
      nativeBackup(input.nativeDatabase, limits.objectBytes, input.runId, []),
  );

export const readRawManifest = (identity: string, limits = DEFAULT_LIMITS) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const blob = yield* blobs.get(Hash.parse(identity));
    if (blob._tag === "Pruned")
      return yield* Effect.fail(
        new RawCapturePruned({
          reason: `raw capture pruned on ${blob.blob.prunedAt}`,
        }),
      );
    if (
      blob.blob.mediaType !== RAW_CAPTURE_MEDIA_TYPE ||
      blob.bytes.byteLength > limits.manifestBytes ||
      sha256Of(blob.bytes) !== identity
    )
      return yield* Effect.fail(new Error("invalid raw capture manifest"));
    return yield* Effect.try(() =>
      readData(RawCapture, JSON.parse(new TextDecoder().decode(blob.bytes))),
    );
  });

export const readRawCapture = (
  identity: string,
  limits = DEFAULT_LIMITS,
  progress: () => void = () => {},
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const manifest = yield* readRawManifest(identity, limits);
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const item of manifest.files) {
      if (
        files.has(item.name) ||
        item.size > captureFileLimit(item.name, limits)
      )
        return yield* Effect.fail(
          new Error("invalid raw capture file inventory"),
        );
      total = checkedCount(total, item.size);
      if (total > limits.totalBytes)
        return yield* Effect.fail(
          new Error("raw capture exceeds total byte limit"),
        );
      const read = yield* blobs.get(item.sha256);
      if (read._tag === "Pruned")
        return yield* Effect.fail(
          new RawCapturePruned({
            reason: `raw capture pruned on ${read.blob.prunedAt}`,
          }),
        );
      if (
        read.bytes.byteLength !== item.size ||
        sha256Of(read.bytes) !== item.sha256
      )
        return yield* Effect.fail(
          new Error("raw capture file unavailable or changed"),
        );
      files.set(item.name, read.bytes);
      progress();
    }
    return { manifest, files };
  });

/** Counts are filed with the immutable raw capture. */
export const rawInventory = (identity: string) =>
  Effect.map(readRawCapture(identity), (raw) => raw.manifest.counts);

export const scanRawCapture = <A>(input: {
  location: StoreLocation;
  rawCapture: string;
  workDirectory?: string;
  progress?: () => void;
  seal: (
    build: BuildInput,
    scan: {
      rawCapture: string;
      policy: typeof CaptureRecords.DETECTOR_VERSION;
    },
  ) => Effect.Effect<A, unknown, Blobs.BlobStore>;
}) =>
  Effect.gen(function* () {
    const { manifest, files } = yield* readRawCapture(
      input.rawCapture,
      DEFAULT_LIMITS,
      input.progress,
    );
    if (manifest.unscannable !== null)
      return yield* Effect.fail(
        new DumpFailed({ reason: manifest.unscannable }),
      );
    const root =
      input.workDirectory ?? join(input.location.directory, "capture-scans");
    yield* Effect.tryPromise(() =>
      mkdir(root, { recursive: true, mode: 0o700 }),
    );
    return yield* Effect.acquireUseRelease(
      Effect.try(() => createCaptureStaging(join(root, "attempt-"))),
      (staging) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.tryPromise(async () => {
              for (const [name, bytes] of files) {
                const path = join(staging, name);
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
                input.progress?.();
              }
            });
            const checkpoint = manifest.checkpoint;
            const journal = files.get(`capture/${JOURNAL_FILE}`);
            const storeDirectory = yield* Effect.tryPromise(() =>
              realpath(input.location.directory),
            );
            const inspection =
              checkpoint === null || journal === undefined
                ? undefined
                : yield* Effect.acquireRelease(
                    Effect.try({
                      try: () =>
                        PrivateInspection.openCaptureCheckpoint({
                          directory: join(
                            storeDirectory,
                            "capture-authorities",
                            checkpoint.id,
                          ),
                          receipt: checkpoint,
                          runId: manifest.runId,
                          journalSha256: sha256Of(journal),
                        }),
                      catch: (error) => error,
                    }),
                    (authority) => Effect.sync(() => authority.close()),
                  );
            const native = files.get("native/pi.sqlite");
            return yield* input.seal(
              {
                runId: manifest.runId,
                journal: join(staging, "capture"),
                capturedBackup: {
                  status: manifest.backup,
                  ...(native === undefined ? {} : { bytes: native }),
                },
                credentialInspection: inspection,
                close: manifest.close ?? undefined,
                rate: manifest.rate ?? undefined,
                declared: manifest.declared,
              },
              {
                rawCapture: input.rawCapture,
                policy: CaptureRecords.DETECTOR_VERSION,
              },
            );
          }),
        ),
      (staging) =>
        Effect.promise(() => rm(staging, { recursive: true, force: true })),
    );
  });
