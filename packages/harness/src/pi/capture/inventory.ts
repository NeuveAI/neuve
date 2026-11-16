import type { DatabaseSync } from "node:sqlite";
import { checkedCount, CloseInventory } from "./watchdog.ts";

type RecordedEvent = { readonly type: string; readonly size?: number };
/** Recorded representations only. Artifacts have original, masked and parsed views. */
export const countRecordedEvent = (
  inventory: CloseInventory,
  event: RecordedEvent,
): CloseInventory =>
  CloseInventory.parse({
    records: checkedCount(inventory.records, 1),
    bytes: checkedCount(
      inventory.bytes,
      event.type === "artifact"
        ? checkedCount(event.size ?? Number.NaN) * 3
        : 0,
    ),
    calls: checkedCount(
      inventory.calls,
      event.type === "model.request" ? 1 : 0,
    ),
    frames: checkedCount(inventory.frames, 1),
  });
export const measuredCloseInventory = (
  lines: readonly { readonly event: RecordedEvent }[],
  recordedBytes: number,
  nativeRecords: number,
): CloseInventory =>
  lines.reduce(
    (inventory, { event }) => countRecordedEvent(inventory, event),
    CloseInventory.parse({
      records: nativeRecords,
      bytes: recordedBytes,
      calls: 0,
      frames: 0,
    }),
  );

export const nativeRecordCount = (database: DatabaseSync) => {
  let records = 0;
  for (const table of database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()) {
    if (typeof table["name"] !== "string")
      throw new Error("invalid native table name");
    const quoted = table["name"].replaceAll('"', '""');
    const count = database
      .prepare(`SELECT count(*) AS n FROM "${quoted}"`)
      .get()?.["n"];
    if (typeof count !== "number")
      throw new Error("invalid native record count");
    records = checkedCount(records, count);
  }
  return records;
};
