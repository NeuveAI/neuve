import { lstat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { openAsItStands } from "@neuve/records-core/read-only";
import { countRecordedEvent, nativeRecordCount } from "./inventory.ts";
import { CloseInventory, checkedCount, closeCeiling } from "./watchdog.ts";
import { JOURNAL_FILE, OBJECTS_DIRECTORY } from "./types.ts";

/** Structural counts only, before a close has published its measured inventory. */
export const recordedCloseInventory = async (
  source: string,
  databaseName = "pi.sqlite",
) => {
  const capture = join(source, "capture");
  const journal = join(capture, JOURNAL_FILE);
  let inventory: CloseInventory = { records: 0, bytes: 0, calls: 0, frames: 0 };
  let bytes = 0;
  try {
    const stat = await lstat(journal);
    if (!stat.isFile())
      throw new Error("capture journal is not a regular file");
    bytes = stat.size;
    let pending = "";
    for await (const chunk of createReadStream(journal, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    })) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 1024 * 1024)
          throw new Error(
            "recorded journal frame exceeds bounded inventory read",
          );
        if (line)
          inventory = countRecordedEvent(inventory, JSON.parse(line).event);
      }
      if (pending.length > 1024 * 1024)
        throw new Error(
          "recorded journal frame exceeds bounded inventory read",
        );
    }
    if (pending.length > 0)
      inventory = countRecordedEvent(inventory, JSON.parse(pending).event);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const objects = join(capture, OBJECTS_DIRECTORY);
  try {
    if (!(await lstat(objects)).isDirectory())
      throw new Error("capture objects is not a directory");
    for (const name of await readdir(objects)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const info = await lstat(join(objects, name));
      if (info.isFile()) bytes = checkedCount(bytes, info.size);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  let records = 0;
  const path = join(source, databaseName);
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error("native database is not a regular file");
    bytes = checkedCount(bytes, stat.size);
    try {
      const wal = await lstat(`${path}-wal`);
      if (!wal.isFile()) throw new Error("native WAL is not a regular file");
      bytes = checkedCount(bytes, wal.size);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    // A count for a time allowance, as it stands. It accepts nothing, so no one is told.
    const { database } = openAsItStands(path);
    try {
      records = nativeRecordCount(database);
    } finally {
      database.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return CloseInventory.parse({
    ...inventory,
    records: checkedCount(inventory.records, records),
    bytes: checkedCount(inventory.bytes, bytes),
  });
};

export const recordedCloseCeiling = async (
  source: string,
  databaseName?: string,
) => closeCeiling(await recordedCloseInventory(source, databaseName));
