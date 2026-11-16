import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { mintUlid } from "./ids.ts";
import {
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
} from "./location.ts";

/**
 * The byte-storage port (11.12): where the bytes of file-placed blobs live, apart from their rows.
 * Rows, placement, retention and tombstones stay in Records (`BlobStore`); this port only keeps
 * bytes by content hash. It is shaped so a hosted object store, such as a Cloudflare Durable Object
 * or an R2 or S3 bucket, can implement it as well as the local file system does:
 *
 * - `put` stores one object whole or not at all (no partial writes), and is idempotent: the same
 *   hash always names the same bytes, so a repeated put changes nothing a reader can see.
 * - `get` returns the bytes, or none when the store holds no object for the hash. It need not
 *   verify them: `BlobStore` re-hashes every read.
 * - `delete` removes the object; deleting an absent object is not an error.
 *
 * There is no listing, renaming or partial write in the port. The media type is passed for stores
 * that keep a content type with the object; the local file system does not need it.
 */

/** A byte-storage operation failed; `cause` is the implementation's own error. */
export class ByteStorageFailed extends Data.TaggedError("ByteStorageFailed")<{
  readonly hash: string;
  readonly operation: "put" | "get" | "delete";
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface StoredObject {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export class ByteStorage extends Context.Service<
  ByteStorage,
  {
    readonly put: (
      object: StoredObject,
    ) => Effect.Effect<void, ByteStorageFailed>;
    readonly get: (
      hash: string,
    ) => Effect.Effect<Option.Option<Uint8Array>, ByteStorageFailed>;
    /**
     * `absent` when the store can tell that nothing was there; a store that cannot tell answers
     * `removed`.
     */
    readonly delete: (
      hash: string,
    ) => Effect.Effect<"removed" | "absent", ByteStorageFailed>;
  }
>()("@neuve/records-core/ByteStorage") {}

/** Where the local file system keeps an object: `<store>/blobs/sha256/<first two hex>/<rest>`. */
export const blobPath = (location: StoreLocation, hash: string) =>
  join(location.blobs, "sha256", hash.slice(0, 2), hash.slice(2));

/**
 * The local file system implementation. A put writes a temporary file beside the object's path,
 * fsyncs it, renames it into place and fsyncs the folder (and the parents of any folder it created),
 * so a crash leaves either the whole object or none, at most with a dot-named temporary beside it.
 */
export const localFileSystem = (location: StoreLocation) =>
  Layer.effect(
    ByteStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem;

      const syncDirectory = (directory: string) =>
        Effect.scoped(
          Effect.flatMap(
            fs.open(directory, { flag: "r" }),
            (handle) => handle.sync,
          ),
        );

      const put = ({ hash, bytes }: StoredObject) => {
        const target = blobPath(location, hash);
        const directory = dirname(target);
        // Unique per put, so concurrent puts of one hash never share a temporary.
        const temporary = join(
          directory,
          `.${hash.slice(2)}.${process.pid}.${mintUlid()}.tmp`,
        );
        return Effect.gen(function* () {
          // `blobs/`, `blobs/sha256/` and the prefix folder may be new: each new folder's entry lives
          // in its parent, which is fsynced so the file's path survives a crash, not just its bytes.
          const created: Array<string> = [];
          for (
            let folder = directory;
            folder.startsWith(location.blobs) && !(yield* fs.exists(folder));
            folder = dirname(folder)
          )
            created.push(folder);
          yield* fs.makeDirectory(directory, {
            recursive: true,
            mode: STORE_DIRECTORY_MODE,
          });
          for (const folder of created.reverse())
            yield* syncDirectory(dirname(folder));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporary, {
                flag: "w",
                mode: STORE_FILE_MODE,
              });
              yield* file.writeAll(bytes);
              yield* file.sync;
            }),
          );
          yield* fs.rename(temporary, target);
          yield* syncDirectory(directory);
        }).pipe(
          Effect.onError(() => Effect.ignore(fs.remove(temporary))),
          Effect.mapError(
            (cause) =>
              new ByteStorageFailed({
                hash,
                operation: "put",
                message: cause.message,
                cause,
              }),
          ),
        );
      };

      const get = (hash: string) =>
        fs.readFile(blobPath(location, hash)).pipe(
          Effect.map((bytes) => Option.some(bytes)),
          Effect.catchTag("PlatformError", (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<Uint8Array>())
              : Effect.fail(
                  new ByteStorageFailed({
                    hash,
                    operation: "get",
                    message: cause.message,
                    cause,
                  }),
                ),
          ),
        );

      const remove = (hash: string) =>
        fs.remove(blobPath(location, hash)).pipe(
          Effect.as("removed" as const),
          Effect.catchTag("PlatformError", (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed("absent" as const)
              : Effect.fail(
                  new ByteStorageFailed({
                    hash,
                    operation: "delete",
                    message: cause.message,
                    cause,
                  }),
                ),
          ),
        );

      return ByteStorage.of({ put, get, delete: remove });
    }),
  );
