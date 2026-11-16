// Outer waits must cover the exact inventory used by a close, including artifacts and live WAL pages.
import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { measuredCloseInventory } from "../../../src/pi/capture/inventory.ts";
import {
  recordedCloseInventory,
  recordedCloseCeiling,
} from "../../../src/pi/capture/recorded-inventory.ts";
import { closeCeiling } from "../../../src/pi/capture/watchdog.ts";

test("recorded inventory covers artifact views and a native backup with uncheckpointed WAL", async () => {
  const root = mkdtempSync(join(tmpdir(), "close-inventory-"));
  const database = new DatabaseSync(join(root, "pi.sqlite"));
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT); INSERT INTO records VALUES (zeroblob(131072));",
    );
    const lines = [
      { event: { type: "artifact", size: 80 * 1024 * 1024 } },
      { event: { type: "model.request" } },
    ];
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    mkdirSync(join(root, "capture"));
    writeFileSync(join(root, "capture", "events.jsonl"), text);
    const pages = database.prepare("PRAGMA page_count").get()?.["page_count"];
    const pageSize = database.prepare("PRAGMA page_size").get()?.["page_size"];
    if (typeof pages !== "number" || typeof pageSize !== "number")
      throw new Error("missing page counts");
    const measured = measuredCloseInventory(
      lines,
      Buffer.byteLength(text) + pages * pageSize,
      1,
    );
    const recorded = await recordedCloseInventory(root);
    expect(recorded).toMatchObject({ records: 3, frames: 2, calls: 1 });
    expect(recorded.bytes).toBeGreaterThanOrEqual(measured.bytes);
    expect(await recordedCloseCeiling(root)).toBeGreaterThanOrEqual(
      closeCeiling(measured),
    );
    expect(await recordedCloseCeiling(root)).toBeGreaterThan(90_000);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a closed source that lost its WAL still counts its records", async () => {
  const root = mkdtempSync(join(tmpdir(), "close-closed-"));
  const path = join(root, "pi.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('a'),('b'); PRAGMA wal_checkpoint(TRUNCATE);",
    );
    database.close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    expect(await recordedCloseInventory(root)).toMatchObject({ records: 2 });
    expect(existsSync(`${path}-wal`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing sources are empty; malformed artifact sizes fail instead of shrinking the clock", async () => {
  const root = mkdtempSync(join(tmpdir(), "close-empty-"));
  try {
    expect(await recordedCloseInventory(root)).toEqual({
      records: 0,
      bytes: 0,
      calls: 0,
      frames: 0,
    });
    mkdirSync(join(root, "capture"));
    writeFileSync(
      join(root, "capture", "events.jsonl"),
      JSON.stringify({ event: { type: "artifact", size: -1 } }) + "\n",
    );
    await expect(recordedCloseInventory(root)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory streams many frames without retaining the journal and bounds a single oversized frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "close-stream-inventory-"));
  try {
    mkdirSync(join(root, "capture"));
    const line = JSON.stringify({ event: { type: "model.request" } }) + "\n";
    writeFileSync(join(root, "capture", "events.jsonl"), line.repeat(10000));
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    expect(await recordedCloseInventory(root)).toEqual({
      records: 10000,
      frames: 10000,
      calls: 10000,
      bytes: Buffer.byteLength(line) * 10000,
    });
    expect(yielded).toBe(true);
    writeFileSync(
      join(root, "capture", "events.jsonl"),
      JSON.stringify({
        event: { type: "model.request", body: "a".repeat(1024 * 1024) },
      }) + "\n",
    );
    await expect(recordedCloseInventory(root)).rejects.toThrow(
      "bounded inventory read",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
