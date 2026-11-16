import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { backupOnConnection } from "./capture/build.ts";

import { publicCloseReason } from "./capture/close-diagnostic.ts";
import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import type { NativeReads } from "./capture/build.ts";

/** Called through SourceOwnership.openNative, which creates the directory and retains ownership. */
export const openNativeStorage = async (path: string) => {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  const adapter = new NodeSqliteDatabase(database);
  try {
    // Match pi-durable 1.0.0's openNodeSqliteDatabase settings without opening a second connection.
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec("PRAGMA wal_autocheckpoint = 1000");
    const storage = await SqliteStorage.open(adapter);
    return Object.assign(storage, {
      captureBackup: (limit: number) => backupOnConnection(database, limit),
    });
  } catch (error) {
    await adapter.close().catch(() => {});
    throw error;
  }
};

/**
 * Why the run's harness is closing. `held`: the job waits for a claim with the credential (10.17).
 * `interrupted`: the attempt stopped and a later claim resumes it (a retryable failure, a stopped
 * worker). `ended`: the job is over and its folder goes once this close succeeded.
 */
export type CloseMode = "held" | "interrupted" | "ended";

/**
 * Exports the run's native state from pi's raw storage while it is still open, and says what it
 * exported. pi's Session has sealed and settled every admitted commit by then, so the export reads
 * the state the next open resumes from. The capture lane owns what it writes and its receipt.
 */
export type ExportOnClose<Receipt> = (input: {
  readonly mode: CloseMode;
  readonly reads: NativeReads;
  readonly context: Context;
}) => Promise<Receipt>;

/** The close barrier failed: the export, the database's close, or both. The run folder stays. */
export class StorageCloseFailed extends Error {
  constructor(
    readonly mode: CloseMode,
    readonly exportError: unknown,
    readonly closeError: unknown,
  ) {
    super(
      [
        exportError === undefined
          ? undefined
          : `export failed: ${publicCloseReason(exportError)}`,
        closeError === undefined
          ? undefined
          : `close failed: ${publicCloseReason(closeError)}`,
      ]
        .filter((part) => part !== undefined)
        .join("; "),
    );
  }
}

/**
 * The run's pi storage with its close as the capture barrier. `Harness.close` seals the Session,
 * settles admitted commits and then awaits `Storage.close`; this close first awaits the export over
 * the raw storage, then closes the database in `finally`, and fails when either failed. One close
 * runs; a repeated call joins it. `closed` gives the export's receipt only once both succeeded.
 */
export const exportingStorage = <Receipt>(
  storage: Storage,
  options: {
    readonly mode: () => CloseMode;
    readonly onClose: ExportOnClose<Receipt>;
  },
): {
  readonly storage: Storage;
  readonly closed: (context: Context) => Promise<Receipt>;
} => {
  let closing: Promise<Receipt> | undefined;
  const close = (context: Context) =>
    (closing ??= (async () => {
      const mode = options.mode();
      // Harness.close has sealed Session admission and joined the scheduler. No pi writer can
      // run between the copy in onClose and storage.close; source ownership excludes other claims.
      // The export settles first, a synchronous throw included; the database closes either way.
      const exported = await Promise.resolve()
        .then(() => options.onClose({ mode, reads: storage, context }))
        .then(
          (receipt) => ({ ok: true as const, receipt }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const closeError = await Promise.resolve()
        .then(() => storage.close(context))
        .then(
          () => undefined,
          (error: unknown) =>
            error ?? new Error("the close failed without a reason"),
        );
      if (!exported.ok || closeError !== undefined)
        throw new StorageCloseFailed(
          mode,
          exported.ok
            ? undefined
            : (exported.error ??
                new Error("the export failed without a reason")),
          closeError,
        );
      return exported.receipt;
    })());
  return {
    storage: new Proxy(storage, {
      get: (target, key) => {
        if (key === "close")
          return (context: Context) => close(context).then(() => undefined);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    closed: close,
  };
};
