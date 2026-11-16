import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { exportSnapshot } from "../../../src/pi/capture/export.ts";

/**
 * Product capture reads a run's native source while it is open: at the raw close, or reopened
 * through pi. These fixtures close pi first and export afterwards, so they hold a connection of
 * their own for the read. Without it the read depends on the WAL still being there, which is up to
 * garbage collection and the Bun version.
 */
export const exportWhileOpen = async (
  input: Parameters<typeof exportSnapshot>[0],
) => {
  const path = input.nativeDatabase;
  if (path === undefined || !existsSync(path)) return exportSnapshot(input);
  const held = new DatabaseSync(path);
  try {
    held.exec("SELECT count(*) FROM sqlite_schema");
    return await exportSnapshot(input);
  } finally {
    held.close();
  }
};
