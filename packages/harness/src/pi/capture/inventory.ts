import type { CaptureLoss } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";
import { checkedCount, CloseInventory } from "./watchdog.ts";

type RecordedEvent = {
  readonly type: string;
  readonly size?: number;
  readonly callId?: string;
};
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
  losses: readonly CaptureLoss[] = [],
): CloseInventory => {
  const inventory = lines.reduce(
    (inventory, { event }) => countRecordedEvent(inventory, event),
    CloseInventory.parse({
      records: nativeRecords,
      bytes: recordedBytes,
      calls: 0,
      frames: 0,
    }),
  );
  if (losses.length === 0) return inventory;
  const lostRequests = new Set(losses.map(({ callId }) => callId));
  for (const { event } of lines)
    if (event.type === "model.request" && event.callId !== undefined)
      lostRequests.delete(event.callId);
  return CloseInventory.parse({
    ...inventory,
    records: checkedCount(inventory.records, losses.length),
    calls: checkedCount(inventory.calls, lostRequests.size),
  });
};

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
