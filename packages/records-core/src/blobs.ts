import { safeRead } from "@neuve/records-schema";
import { join } from "node:path";
import { Clock, Context, Data, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient } from "effect/sql/SqlClient";
import { BlobRow, type BlobRetention } from "@neuve/records-schema";
import { ByteStorage, localFileSystem } from "./byte-storage.ts";
import { sha256Bytes } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import type { StoreLocation } from "./location.ts";
import { assertCompatible, type StoreError } from "./store.ts";

export { blobPath } from "./byte-storage.ts";

/**
 * Blobs up to this size keep their bytes in the database row; larger ones go to byte storage (D11,
 * 11.12), which is the local file system today. SQLite's guidance is that small blobs read faster
 * from the database than from separate files, so inline blobs stay inline whatever byte storage
 * holds the larger ones.
 */
export const INLINE_MAX_BYTES = 131_072;

/** One entry in a blob prefix folder; `hash` is set when its name is a blob file's name. */
export interface BlobFolderEntry {
  readonly path: string;
  readonly hash: string | undefined;
}

/**
 * Every entry inside the `blobs/sha256/<two hex>/` folders. Anything else under `blobs/sha256/`,
 * such as a `.DS_Store` file or a folder with another name, is not a blob folder and is skipped.
 * Inside a folder, dot-prefixed names are temporaries of puts in progress or interrupted, and have
 * no `hash`.
 */
export const blobFolderEntries = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const root = join(location.blobs, "sha256");
    const entries: Array<BlobFolderEntry> = [];
    if (!(yield* fs.exists(root))) return entries;
    for (const prefix of yield* fs.readDirectory(root)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const folder = join(root, prefix);
      if ((yield* fs.stat(folder)).type !== "Directory") continue;
      for (const name of yield* fs.readDirectory(folder))
        entries.push({
          path: join(folder, name),
          hash:
            !name.startsWith(".") && /^[0-9a-f]{62}$/.test(name)
              ? `${prefix}${name}`
              : undefined,
        });
    }
    return entries as ReadonlyArray<BlobFolderEntry>;
  });

/** No blob row exists for the hash. */
export class BlobMissing extends Data.TaggedError("BlobMissing")<{
  readonly hash: string;
}> {}

/** A blob's stored bytes are absent or no longer hash to its name. */
export class BlobCorrupt extends Data.TaggedError("BlobCorrupt")<{
  readonly hash: string;
  readonly message: string;
}> {}

/**
 * Removing a pruned blob's bytes failed; its tombstone is committed and the next prune retries.
 * `cause` is byte storage's own error.
 */
export class BlobRemoveFailed extends Data.TaggedError("BlobRemoveFailed")<{
  readonly hash: string;
  readonly cause: unknown;
}> {}

/** Listing the blob folders failed while looking for files beside tombstones. */
export class BlobScanFailed extends Data.TaggedError("BlobScanFailed")<{
  readonly cause: PlatformError;
}> {}

/** Storing a blob's bytes failed; no row was recorded. `cause` is byte storage's own error. */
export class BlobWriteFailed extends Data.TaggedError("BlobWriteFailed")<{
  readonly hash: string;
  readonly cause: unknown;
}> {}

export class BlobPruned extends Data.TaggedError("BlobPruned")<{
  readonly hash: string;
  readonly prunedAt: string;
}> {
  override get message() {
    return `raw capture pruned on ${this.prunedAt}`;
  }
}

export interface PutRequest {
  /** Derived captures must never restart an expired source's retention clock. */
  readonly restore?: "never";
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** The producer sets the class (proposal §7); durable wins when the same bytes arrive as both. */
  readonly retention: BlobRetention;
}

export interface PutResult {
  /** `restored`: the bytes had been pruned and are kept again, as a new capture (8.10). */
  readonly status: "stored" | "existing" | "restored";
  readonly blob: BlobRow;
}

/** A raw capture whose bytes one prune removed; its row stays as the tombstone. */
export interface PrunedBlob {
  readonly hash: string;
  readonly size: number;
  readonly mediaType: string;
  readonly placement: "inline" | "file";
  readonly capturedAt: string;
}

/**
 * What promoting a blob to durable found (8.10): `promoted` from raw capture, already `durable`,
 * `pruned` (the bytes are gone, so nothing can keep them), or `missing` (no row for the hash).
 * Promoting again answers `durable`, so a replayed promotion changes nothing.
 */
export type PromoteResult = "promoted" | "durable" | "pruned" | "missing";

/** A blob read back: its verified bytes, or the tombstone of a pruned raw capture. */
export type BlobRead =
  | {
      readonly _tag: "Present";
      readonly blob: BlobRow;
      readonly bytes: Uint8Array;
    }
  | { readonly _tag: "Pruned"; readonly blob: BlobRow };

/**
 * The content-addressed blob store (5.3, D11). It owns the rows: hash, size, media type, placement,
 * retention and tombstones. A file blob's bytes go through the byte-storage port (11.12,
 * `byte-storage.ts`); inline blobs keep theirs in the row. The store computes every hash itself and
 * re-hashes bytes on every read.
 *
 * Ordering keeps a committed live row from ever lacking its bytes. A new blob's bytes are stored
 * before its row commits. A standalone put stores new bytes before taking the write lock; a
 * computation success encloses the put in its binding transaction. Byte storage loses bytes only when the pruner
 * deletes a tombstoned hash's bytes, under the write lock, and a hash with no row has no tombstone;
 * or when an eviction's removal deletes a hash marked in `blob_removals` that still has no row, also
 * under the write lock. A put of a hash marked for removal therefore stores its bytes under the lock
 * too, and its new row cancels the mark (the `blob_removals_cancel` trigger).
 * Restoring pruned bytes stores them under the write lock, in the transaction that clears the
 * tombstone, so a prune of the same hash cannot interleave. A crash before the commit leaves only
 * bytes no row names (or a temporary of the local file system), or bytes beside a tombstone, which
 * the next prune removes.
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly put: (
      request: PutRequest,
    ) => Effect.Effect<PutResult, StoreError | BlobWriteFailed | BlobPruned>;
    readonly get: (
      hash: string,
    ) => Effect.Effect<BlobRead, StoreError | BlobMissing | BlobCorrupt>;
    /** Bounded metadata/content reads; every returned blob still has its bytes re-hashed. */
    readonly getMany: (
      hashes: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyMap<string, BlobRead>,
      StoreError | BlobMissing | BlobCorrupt
    >;
    readonly inspect: (
      hash: string,
    ) => Effect.Effect<Option.Option<BlobRow>, StoreError>;
    /**
     * Keeps a raw capture permanently (8.10), as Publish does for the proof artefacts a published
     * packet cites (proposal §10.2). Idempotent; it never touches the bytes.
     */
    readonly promote: (
      hash: string,
    ) => Effect.Effect<PromoteResult, StoreError>;
    /**
     * Prunes up to `limit` raw captures captured before `cutoff`, oldest first (8.10, D26). Their
     * tombstones commit first, clearing inline bytes; then, in a second transaction, each file is
     * removed while its row still reads pruned. A crash between the two leaves files beside
     * tombstones, which `removeLeftovers` finishes. Durable blobs are never selected, and the schema
     * refuses a tombstone on one.
     */
    readonly prune: (options: {
      readonly cutoff: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<PrunedBlob>,
      StoreError | BlobRemoveFailed
    >;
    /**
     * Hashes of files still on disk beside a tombstone: an interrupted prune's remainder. This scan
     * reads the local file system's layout, because the byte-storage port has no listing; with a
     * hosted byte storage it finds nothing locally.
     */
    readonly leftovers: Effect.Effect<
      ReadonlyArray<string>,
      StoreError | BlobScanFailed
    >;
    /** Removes the bytes of `hashes` whose rows still read pruned; returns how many it removed. */
    readonly removeLeftovers: (
      hashes: ReadonlyArray<string>,
    ) => Effect.Effect<number, StoreError | BlobRemoveFailed>;
    /**
     * Finishes the removals an eviction recorded in `blob_removals` (all of them, or only `hashes`):
     * under the write lock, a hash that still has no row loses its bytes, and then its mark. A hash
     * whose row came back keeps its bytes. Returns how many objects it removed. A failure leaves the
     * mark, and the next eviction tries again.
     */
    readonly removeEvicted: (
      hashes?: ReadonlyArray<string>,
    ) => Effect.Effect<number, StoreError | BlobRemoveFailed>;
  }
>()("@neuve/records-core/BlobStore") {}

const COLUMNS =
  "hash, size, media_type, retention, placement, captured_at, pruned_at";

const decodeRow = (row: unknown) => {
  const parsed = safeRead(BlobRow, row);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new CorruptRecord({ message: `blob row: ${parsed.error.message}` }),
      );
};

/**
 * The blob store over whatever byte storage the context provides. The leftover scan still reads the
 * local folders under `location` (see `leftovers`).
 */
export const layerOnStorage = (location: StoreLocation) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const fs = yield* FileSystem;
      const storage = yield* ByteStorage;

      const inspect = (hash: string) =>
        Effect.gen(function* () {
          const [row] = yield* sql.unsafe(
            `SELECT ${COLUMNS} FROM blobs WHERE hash = ?`,
            [hash],
          );
          if (row === undefined) return Option.none<BlobRow>();
          return Option.some(yield* decodeRow(row));
        });

      const storeBytes = (request: PutRequest, hash: string) =>
        storage
          .put({ hash, bytes: request.bytes, mediaType: request.mediaType })
          .pipe(
            Effect.mapError(
              (failure) => new BlobWriteFailed({ hash, cause: failure.cause }),
            ),
          );

      /** Whether an eviction marked the hash for removal and its removal has not finished. */
      const removalPending = (hash: string) =>
        Effect.map(
          sql<{
            hash: string;
          }>`SELECT hash FROM blob_removals WHERE hash = ${hash}`,
          (rows) => rows.length > 0,
        );

      const put = (request: PutRequest) =>
        Effect.gen(function* () {
          const hash = sha256Bytes(request.bytes);
          const size = request.bytes.byteLength;
          const placement = size <= INLINE_MAX_BYTES ? "inline" : "file";
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          const content = placement === "inline" ? request.bytes : null;
          // Store new bytes ahead of this put's transaction. A caller may already hold a transaction.
          // Not when an eviction's removal of the hash is pending: that removal could delete them
          // before this row commits, so they are stored under the lock instead.
          // A store not yet migrated has no such table; the transaction's version gate says so.
          const storedAhead =
            placement === "file" &&
            Option.isNone(yield* inspect(hash)) &&
            !(yield* removalPending(hash).pipe(
              Effect.catchTag("SqlError", () => Effect.succeed(true)),
            ));
          if (storedAhead) yield* storeBytes(request, hash);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* assertCompatible;
              const held = yield* inspect(hash);
              if (
                request.restore === "never" &&
                Option.isSome(held) &&
                held.value.prunedAt !== null
              )
                return yield* Effect.fail(
                  new BlobPruned({ hash, prunedAt: held.value.prunedAt }),
                );
              // A live row's bytes are already stored. A pruned row needs them stored again under
              // this lock; so does a missing row whose bytes were not stored ahead (a row that was
              // there at the first look and is gone now, which the schema's guards never allow).
              const needsBytes =
                placement === "file" &&
                (Option.isNone(held) || held.value.prunedAt !== null);
              if (
                needsBytes &&
                !(
                  storedAhead &&
                  Option.isNone(held) &&
                  !(yield* removalPending(hash))
                )
              )
                yield* storeBytes(request, hash);
              if (Option.isNone(held)) {
                const blob = yield* decodeRow({
                  hash,
                  size,
                  mediaType: request.mediaType,
                  retention: request.retention,
                  placement,
                  capturedAt: at,
                  prunedAt: null,
                });
                yield* sql`INSERT INTO blobs ${sql.insert({
                  hash,
                  size,
                  media_type: request.mediaType,
                  retention: request.retention,
                  placement,
                  captured_at: at,
                  pruned_at: null,
                  content,
                })}`;
                return {
                  status: "stored",
                  blob,
                } satisfies PutResult;
              }
              const upgrade =
                request.retention === "durable" &&
                held.value.retention !== "durable";
              if (held.value.prunedAt !== null) {
                // Fetched again after pruning: a new capture with its own clock (8.10).
                yield* sql`UPDATE blobs SET pruned_at = NULL, captured_at = ${at},
                  content = ${content}, retention = ${upgrade ? "durable" : held.value.retention}
                  WHERE hash = ${hash}`;
                return {
                  status: "restored",
                  blob: {
                    ...held.value,
                    capturedAt: at,
                    prunedAt: null,
                    retention: upgrade ? "durable" : held.value.retention,
                  },
                } satisfies PutResult;
              }
              if (upgrade)
                yield* sql`UPDATE blobs SET retention = 'durable' WHERE hash = ${hash}`;
              return {
                status: "existing",
                blob: upgrade
                  ? { ...held.value, retention: "durable" }
                  : held.value,
              } satisfies PutResult;
            }),
          );
        });

      const promote = (hash: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertCompatible;
            const held = yield* inspect(hash);
            if (Option.isNone(held)) return "missing" satisfies PromoteResult;
            if (held.value.prunedAt !== null)
              return "pruned" satisfies PromoteResult;
            if (held.value.retention === "durable")
              return "durable" satisfies PromoteResult;
            // The guards on `blobs` allow raw capture to durable, never back.
            yield* sql`UPDATE blobs SET retention = 'durable' WHERE hash = ${hash}`;
            return "promoted" satisfies PromoteResult;
          }),
        );

      /** The tombstone when the blob was pruned meanwhile, so a read racing a prune is not corruption. */
      const prunedMeanwhile = (hash: string, corrupt: BlobCorrupt) =>
        Effect.gen(function* () {
          const now = yield* inspect(hash);
          if (Option.isSome(now) && now.value.prunedAt !== null)
            return { _tag: "Pruned", blob: now.value } satisfies BlobRead;
          return yield* corrupt;
        });

      const readRow = (
        row: BlobRow & { readonly content: Uint8Array | null },
      ): Effect.Effect<
        BlobRead,
        StoreError | BlobMissing | BlobCorrupt,
        SqlClient
      > =>
        Effect.gen(function* () {
          const { content, ...metadata } = row;
          const blob = yield* decodeRow(metadata);
          const hash = blob.hash;
          if (blob.prunedAt !== null)
            return { _tag: "Pruned", blob } satisfies BlobRead;
          let bytes: Uint8Array;
          if (blob.placement === "inline") {
            if (content === null || content === undefined)
              return yield* prunedMeanwhile(
                hash,
                new BlobCorrupt({
                  hash,
                  message: "inline blob has no content",
                }),
              );
            bytes = content;
          } else {
            const read = yield* Effect.result(storage.get(hash));
            if (read._tag === "Failure" || Option.isNone(read.success))
              return yield* prunedMeanwhile(
                hash,
                new BlobCorrupt({
                  hash,
                  message: `file unreadable: ${read._tag === "Failure" ? read.failure.message : "byte storage holds no object for it"}`,
                }),
              );
            bytes = read.success.value;
          }
          if (bytes.byteLength !== blob.size || sha256Bytes(bytes) !== hash)
            return yield* new BlobCorrupt({
              hash,
              message: `stored bytes (${bytes.byteLength}) do not hash to the blob's name`,
            });
          return { _tag: "Present", blob, bytes } satisfies BlobRead;
        });

      const readOnce = (hash: string) =>
        Effect.gen(function* () {
          const [row] = yield* sql.unsafe<
            BlobRow & { content: Uint8Array | null }
          >(`SELECT ${COLUMNS}, content FROM blobs WHERE hash = ?`, [hash]);
          if (row === undefined) return yield* new BlobMissing({ hash });
          return yield* readRow(row);
        });

      /**
       * Reads a blob, once more when the first read finds its bytes missing or wrong: a prune and a
       * new capture of the same bytes may both land between reading the row and reading the bytes.
       * Bytes that are still wrong on the second read are corrupt.
       */
      const get = (hash: string) =>
        readOnce(hash).pipe(
          Effect.catchTag("BlobCorrupt", () => readOnce(hash)),
        );

      const getMany = (hashes: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const found = new Map<string, BlobRead>();
          const unique = [...new Set(hashes)];
          for (let offset = 0; offset < unique.length; offset += 500) {
            const page = unique.slice(offset, offset + 500);
            const rows = yield* sql<
              BlobRow & { content: Uint8Array | null }
            >`SELECT
              hash, size, media_type, retention, placement, captured_at, pruned_at, content
              FROM blobs WHERE ${sql.in("hash", page)}`;
            for (const row of rows) {
              const read = yield* readRow(row).pipe(
                Effect.catchTag("BlobCorrupt", () => readOnce(row.hash)),
              );
              found.set(read.blob.hash, read);
            }
            for (const hash of page)
              if (!found.has(hash)) return yield* new BlobMissing({ hash });
          }
          return found;
        });

      /**
       * Deletes the bytes of each hash whose row reads pruned, under the write lock: a put that
       * restores the same bytes stores them under that lock too, so it never loses them to this
       * removal. Bytes already absent count as removed before.
       */
      const removePrunedFiles = (hashes: ReadonlyArray<string>) =>
        hashes.length === 0
          ? Effect.succeed(0)
          : sql.withTransaction(
              Effect.gen(function* () {
                yield* assertCompatible;
                let removed = 0;
                for (const hash of hashes) {
                  const held = yield* inspect(hash);
                  if (Option.isNone(held) || held.value.prunedAt === null)
                    continue;
                  const outcome = yield* storage
                    .delete(hash)
                    .pipe(
                      Effect.mapError(
                        (failure) =>
                          new BlobRemoveFailed({ hash, cause: failure.cause }),
                      ),
                    );
                  if (outcome === "removed") removed += 1;
                }
                return removed;
              }),
            );

      const prune = (options: {
        readonly cutoff: string;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          const pruned = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* assertCompatible;
              yield* sql`PRAGMA secure_delete = ON`;
              // The guards on `blobs` allow exactly this change: bytes cleared, pruned date set,
              // retention and capture date kept.
              return yield* sql<PrunedBlob>`UPDATE blobs SET pruned_at = ${at}, content = NULL
                WHERE hash IN (SELECT hash FROM blobs
                  WHERE retention = 'raw-capture' AND pruned_at IS NULL AND captured_at < ${options.cutoff}
                  ORDER BY captured_at, hash LIMIT ${options.limit})
                RETURNING hash, size, media_type, placement, captured_at`;
            }),
          );
          yield* removePrunedFiles(
            pruned
              .filter((blob) => blob.placement === "file")
              .map((blob) => blob.hash),
          );
          return pruned as ReadonlyArray<PrunedBlob>;
        });

      /**
       * One transaction per hash: the write lock is held only while one object is removed, and a
       * put of the same hash, which stores under that lock while the mark is there, cannot
       * interleave. The bytes go before the mark, so a crash between leaves the mark for next time.
       */
      const removeEvicted = (hashes?: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const marked =
            hashes === undefined
              ? (yield* sql<{
                  hash: string;
                }>`SELECT hash FROM blob_removals ORDER BY at, hash`).map(
                  (row) => row.hash,
                )
              : hashes;
          let removed = 0;
          for (const hash of marked)
            removed += yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* assertCompatible;
                if (!(yield* removalPending(hash))) return 0;
                let gone = 0;
                if (Option.isNone(yield* inspect(hash))) {
                  const outcome = yield* storage
                    .delete(hash)
                    .pipe(
                      Effect.mapError(
                        (failure) =>
                          new BlobRemoveFailed({ hash, cause: failure.cause }),
                      ),
                    );
                  if (outcome === "removed") gone = 1;
                }
                yield* sql`DELETE FROM blob_removals WHERE hash = ${hash}`;
                return gone;
              }),
            );
          return removed;
        });

      const leftovers = Effect.gen(function* () {
        const entries = yield* Effect.provideService(
          blobFolderEntries(location),
          FileSystem,
          fs,
        );
        const onDisk = entries
          .filter((entry) => entry.hash !== undefined)
          .map((entry) => entry.hash!);
        const found: Array<string> = [];
        for (let index = 0; index < onDisk.length; index += 500) {
          const page = onDisk.slice(index, index + 500);
          const rows = yield* sql<{
            hash: string;
          }>`SELECT hash FROM blobs WHERE pruned_at IS NOT NULL AND ${sql.in("hash", page)}`;
          for (const row of rows) found.push(row.hash);
        }
        return found as ReadonlyArray<string>;
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(new BlobScanFailed({ cause })),
        ),
      );

      return BlobStore.of({
        put: (request) => Effect.provideService(put(request), SqlClient, sql),
        get: (hash) => Effect.provideService(get(hash), SqlClient, sql),
        getMany: (hashes) =>
          Effect.provideService(getMany(hashes), SqlClient, sql),
        inspect: (hash) => Effect.provideService(inspect(hash), SqlClient, sql),
        promote: (hash) => Effect.provideService(promote(hash), SqlClient, sql),
        prune: (options) =>
          Effect.provideService(prune(options), SqlClient, sql),
        leftovers: Effect.provideService(leftovers, SqlClient, sql),
        removeLeftovers: (hashes) =>
          Effect.provideService(removePrunedFiles(hashes), SqlClient, sql),
        removeEvicted: (hashes) =>
          Effect.provideService(removeEvicted(hashes), SqlClient, sql),
      });
    }),
  );

/** The blob store over the local file system's byte storage under `location` (11.12). */
export const layer = (location: StoreLocation) =>
  layerOnStorage(location).pipe(Layer.provide(localFileSystem(location)));
