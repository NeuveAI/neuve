import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { STORE_DIRECTORY_MODE, STORE_FILE_MODE } from "@neuve/records-core";
import type { RunLogRecord } from "./run-log.ts";

// Fixed-size, per-writer files. Never truncate or remove them while their writer is alive.
// MAP_SHARED counts survive process death without appending in a pi commit listener.
const fields = {
  version: 0,
  pid: 1,
  attempts: 2,
  dropped: 3,
  failures: 4,
  settled: 5,
} as const;
const bytes = Object.keys(fields).length * 8;
const directoryOf = (path: string) =>
  join(
    dirname(path),
    "..",
    "telemetry-state",
    basename(dirname(path)),
    basename(path),
  );
const LedgerState = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  settled: z.union([z.literal(0), z.literal(1)]),
});
const viewOf = (data: Uint8Array) => {
  if (data.byteLength !== bytes)
    throw new Error("Invalid telemetry ledger size");
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
};
const valueOf = (view: DataView, field: keyof typeof fields) =>
  view.getFloat64(fields[field] * 8, true);

export const openTelemetryLedger = (path: string, writer: string) => {
  const directory = directoryOf(path);
  mkdirSync(directory, { recursive: true, mode: STORE_DIRECTORY_MODE });
  const file = join(directory, `${writer}.bin`);
  const initial = new Uint8Array(bytes);
  const initialView = viewOf(initial);
  initialView.setFloat64(fields.version * 8, 1, true);
  initialView.setFloat64(fields.pid * 8, process.pid, true);
  initialView.setFloat64(fields.settled * 8, 1, true);
  writeFileSync(file, initial, { flag: "wx", mode: STORE_FILE_MODE });
  const view = viewOf(Bun.mmap(file, { shared: true }));
  return {
    remove: () => {
      try {
        rmSync(file, { force: true });
      } catch {}
    },
    set: (field: keyof typeof fields, value: number) =>
      view.setFloat64(fields[field] * 8, value, true),
  };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

/** Snapshot counters before the log: a completed append cannot appear as loss from an older read. */
export const telemetryLoss = (path: string) => {
  const directory = directoryOf(path);
  const snapshots = !existsSync(directory)
    ? []
    : readdirSync(directory).flatMap(
        (
          file,
        ): Array<{
          writer: string;
          state: z.infer<typeof LedgerState> | undefined;
        }> => {
          if (!file.endsWith(".bin")) return [];
          const writer = file.slice(0, -4);
          if (!z.string().uuid().safeParse(writer).success) return [];
          try {
            const view = viewOf(readFileSync(join(directory, file)));
            return [
              {
                writer,
                state: LedgerState.parse({
                  version: valueOf(view, "version"),
                  pid: valueOf(view, "pid"),
                  attempts: valueOf(view, "attempts"),
                  dropped: valueOf(view, "dropped"),
                  failures: valueOf(view, "failures"),
                  settled: valueOf(view, "settled"),
                }),
              },
            ];
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return [];
            return [{ writer, state: undefined }];
          }
        },
      );
  return (records: ReadonlyArray<RunLogRecord>): RunLogRecord[] => {
    const ids = new Map<string, Set<string>>();
    for (const record of records) {
      const id = record["telemetryId"];
      if (typeof id !== "string") continue;
      const writer = id.split(":")[0] ?? "";
      const seen = ids.get(writer) ?? new Set<string>();
      seen.add(id);
      ids.set(writer, seen);
    }
    return snapshots.flatMap(({ writer, state }): RunLogRecord[] => {
      if (!state)
        return [
          {
            type: "telemetry.loss",
            writer,
            recordsLost: null,
            accounting: "unreadable",
          },
        ];
      const missing = Math.max(
        0,
        state.attempts - (ids.get(writer)?.size ?? 0),
      );
      const active = state.settled === 0 && alive(state.pid);
      const lost = active ? Math.min(missing, state.dropped) : missing;
      return missing || state.failures
        ? [
            {
              type: "telemetry.loss",
              writer,
              recordsLost: lost,
              pendingRecords: missing - lost,
              writeFailures: state.failures,
            },
          ]
        : [];
    });
  };
};

/** Remove old orphan accounting. Loss must live as long as its log, and live writers are retained. */
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const pruneTelemetryLedgers = (root: string, now = Date.now()) => {
  const result = { pruned: 0, unreadable: 0 };
  try {
    for (const kind of readdirSync(root, { withFileTypes: true })) {
      if (!kind.isDirectory()) continue;
      const kindRoot = join(root, kind.name);
      for (const log of readdirSync(kindRoot, { withFileTypes: true })) {
        if (!log.isDirectory()) continue;
        const directory = join(kindRoot, log.name);
        for (const file of readdirSync(directory)) {
          if (!file.endsWith(".bin")) continue;
          const path = join(directory, file);
          try {
            if (now - statSync(path).mtimeMs < TELEMETRY_RETENTION_MS) continue;
            const view = viewOf(readFileSync(path));
            if (
              !alive(valueOf(view, "pid")) &&
              !existsSync(join(root, "..", kind.name, log.name))
            ) {
              rmSync(path, { force: true });
              result.pruned++;
            }
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ))
              result.unreadable++;
          }
        }
        try {
          rmdirSync(directory);
        } catch {}
      }
    }
  } catch {
    /* Retention is best effort and cannot change execution. */
  }
  return result;
};
