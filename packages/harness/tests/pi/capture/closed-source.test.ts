// Why: direct exports must refuse a closed or lost-WAL source without a whole-source credential certificate.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeBackup } from "../../../src/pi/capture/build.ts";
import { readAsItStands, walWithoutLog } from "@neuve/records-core/read-only";
import { sha256Of } from "../../../src/pi/capture/journal.ts";

const root = mkdtempSync(join(tmpdir(), "closed-source-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const LIMIT = 16 * 1024 * 1024;
const REFUSAL =
  "closed source with no WAL matches no credential certificate; source retained";

let cases = 0;
const walSource = () => {
  const directory = join(root, String(cases++));
  const path = `${directory}.sqlite`;
  const writer = new DatabaseSync(path);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(value); INSERT INTO t VALUES ('committed')",
  );
  return { path, writer };
};

/** The state a clean close leaves, reached the same way on every Bun and platform. */
const closedCleanly = () => {
  const { path, writer } = walSource();
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.close();
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  return { path };
};

test("a closed source with no record is refused, on every platform", async () => {
  const { path } = closedCleanly();
  await expect(nativeBackup(path, LIMIT, "run", [])).rejects.toMatchObject({
    _tag: "DumpFailed",
    reason: expect.stringContaining(REFUSAL),
  });
});

test("a lost WAL is refused without a whole-source credential certificate", async () => {
  const { path, writer } = walSource();
  const image = new DatabaseSync(path, { readOnly: true });
  const sha256 = sha256Of(image.serialize());
  image.close();
  expect(sha256Of(new Uint8Array(readFileSync(path)))).not.toBe(sha256);
  try {
    rmSync(`${path}-wal`);
    rmSync(`${path}-shm`, { force: true });
    await expect(nativeBackup(path, LIMIT, "run", [])).rejects.toMatchObject({
      _tag: "DumpFailed",
      reason: expect.stringContaining(REFUSAL),
    });
  } finally {
    writer.close();
  }
});

test("a source whose WAL is present reads through it", async () => {
  const { path, writer } = walSource();
  try {
    const backup = await nativeBackup(path, LIMIT, "run", []);
    expect(backup.status).toMatchObject({ status: "captured" });
    expect(backup.bytes).toEqual(
      new Uint8Array(new DatabaseSync(path, { readOnly: true }).serialize()),
    );
  } finally {
    writer.close();
  }
});

test("a database not in WAL mode has no WAL to lose", async () => {
  const { path, writer } = walSource();
  writer.exec("PRAGMA journal_mode=DELETE");
  writer.close();
  expect(walWithoutLog(path)).toBe(false);
  expect((await nativeBackup(path, LIMIT, "run", [])).status).toMatchObject({
    status: "captured",
  });
});

test("counting reads a closed source without leaving sidecars", () => {
  const { path } = closedCleanly();
  const before = readdirSync(root).length;
  expect(
    readAsItStands(
      path,
      (database) =>
        database.prepare("SELECT count(*) AS n FROM t").get()?.["n"],
    ),
  ).toEqual({ value: 1, withoutLog: true });
  expect(readdirSync(root).length).toBe(before);
});
