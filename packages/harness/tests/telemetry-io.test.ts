import { randomUUID } from "node:crypto";
import {
  openTelemetryLedger,
  pruneTelemetryLedgers,
  TELEMETRY_RETENTION_MS,
} from "../src/telemetry-loss.ts";
import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeLocationIn } from "@neuve/records-core";
import { enqueueTelemetry, openRunLog, readRunLog } from "../src/run-log.ts";
const root = mkdtempSync(join(tmpdir(), "telemetry-io-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("queued observations are readable once before and after disk flush", async () => {
  const log = openRunLog(storeLocationIn(join(root, "success")), "r");
  enqueueTelemetry(log, { type: "model.call.start", call: "c" });
  enqueueTelemetry(log, {
    type: "model.call",
    call: "c",
    finishReason: "stop",
  });
  expect(log.read().map((record) => record.type)).toEqual([
    "model.call.start",
    "model.call",
  ]);
  await log.flush?.();
  expect(log.read().map((record) => record.type)).toEqual([
    "model.call.start",
    "model.call",
  ]);
  expect(readRunLog(log.path)).toHaveLength(2);
});

test("an unwritable observation sink reports loss and its flush settles", async () => {
  const blocked = join(root, "file");
  writeFileSync(blocked, "fixture");
  const log = openRunLog(storeLocationIn(blocked), "r");
  enqueueTelemetry(log, { type: "model.call", call: "c" });
  await log.flush?.();
  expect(log.read()).toContainEqual(
    expect.objectContaining({ type: "telemetry.loss", recordsLost: 1 }),
  );
});

test("the observation queue is bounded rather than blocking the producer", async () => {
  const log = openRunLog(storeLocationIn(join(root, "bounded")), "r");
  for (let i = 0; i < 1100; i++)
    enqueueTelemetry(log, { type: "observation", n: i });
  expect(log.read().filter((row) => row.type === "observation")).toHaveLength(
    1024,
  );
  await log.flush?.();
  expect(log.read().filter((row) => row.type === "observation")).toHaveLength(
    1024,
  );
  expect(log.read()).toContainEqual(
    expect.objectContaining({ type: "telemetry.loss", recordsLost: 76 }),
  );
});

// Control records feed the receipt; failed writes must prevent silent omissions.
test("control record write failures are observable", () => {
  const blocked = join(root, "control-blocked");
  writeFileSync(blocked, "fixture");
  const log = openRunLog(storeLocationIn(blocked), "r");
  for (const type of ["stage", "gap", "preflight"])
    expect(() => log.write({ type })).toThrow();
});

// Process boundaries prove that observations survive explicit exits or disclose a forced loss.
for (const mode of ["natural", "exit", "failure", "kill"]) {
  test(`telemetry at process exit: ${mode}`, async () => {
    const directory = join(root, `exit-${mode}`);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/telemetry-exit.ts"),
        directory,
        mode,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode === 0).toBe(mode === "natural" || mode === "exit");
    const path = join(directory, "neuve", "run-logs", "r.jsonl");
    const records = readRunLog(path);
    if (mode === "kill") {
      expect(
        records.filter((row) => row.type.startsWith("model.call")),
      ).toHaveLength(0);
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "telemetry.loss",
          recordsLost: 2,
          pendingRecords: 0,
        }),
      );
    } else {
      expect(records.map((row) => row.type)).toEqual([
        "model.call.start",
        "model.call",
      ]);
    }
  });
}

// A long-lived host opens many logs, and one log can receive observations again after flushing.
test("clean settled ledgers are retired and later observations remain loss-accounted", async () => {
  const location = storeLocationIn(join(root, "retention"));
  const log = openRunLog(location, "r");
  const folder = join(
    location.directory,
    "telemetry-state",
    "run-logs",
    "r.jsonl",
  );
  expect(existsSync(folder)).toBe(false);
  for (let i = 0; i < 3; i++) {
    enqueueTelemetry(log, { type: "observation", n: i });
    expect(readdirSync(folder)).toHaveLength(1);
    await log.flush?.();
    expect(readdirSync(folder)).toEqual([]);
  }
  expect(readRunLog(log.path).map((row) => row.type)).toEqual([
    "observation",
    "observation",
    "observation",
  ]);
});

test("retention preserves expired crash accounting while its run log exists", async () => {
  const location = storeLocationIn(join(root, "expired"));
  const log = openRunLog(location, "r");
  log.write({ type: "stage", stage: "fixture" });
  const folder = join(
    location.directory,
    "telemetry-state",
    "run-logs",
    "r.jsonl",
  );
  const child = Bun.spawn(["sleep", "30"]);
  child.kill();
  await child.exited;
  const oldDead = randomUUID(),
    recentDead = randomUUID(),
    oldLive = randomUUID();
  for (const writer of [oldDead, recentDead, oldLive]) {
    const ledger = openTelemetryLedger(log.path, writer);
    ledger.set("attempts", 2);
    ledger.set("pid", writer === oldLive ? process.pid : child.pid);
    if (writer !== recentDead) {
      const old = new Date(Date.now() - TELEMETRY_RETENTION_MS - 1000);
      utimesSync(join(folder, `${writer}.bin`), old, old);
    }
  }
  pruneTelemetryLedgers(join(location.directory, "telemetry-state"));
  expect(readdirSync(folder).sort()).toEqual(
    [`${oldDead}.bin`, `${recentDead}.bin`, `${oldLive}.bin`].sort(),
  );
  expect(
    readRunLog(log.path)
      .filter((row) => row.type === "telemetry.loss")
      .map((row) => row.recordsLost),
  ).toEqual([2, 2, 2]);
});

// A malformed writer must not prevent unrelated orphan ledgers from expiring.
test("retention skips and counts corrupt ledgers before continuing", async () => {
  const location = storeLocationIn(join(root, "corrupt-retention"));
  const log = openRunLog(location, "orphan");
  const folder = join(
    location.directory,
    "telemetry-state",
    "run-logs",
    "orphan.jsonl",
  );
  const child = Bun.spawn(["sleep", "30"]);
  child.kill();
  await child.exited;
  const writer = randomUUID();
  const ledger = openTelemetryLedger(log.path, writer);
  ledger.set("pid", child.pid);
  const corrupt = join(folder, "00000000-0000-4000-8000-000000000000.bin");
  writeFileSync(corrupt, "bad");
  const old = new Date(Date.now() - TELEMETRY_RETENTION_MS - 1000);
  for (const file of readdirSync(folder))
    utimesSync(join(folder, file), old, old);
  expect(
    pruneTelemetryLedgers(join(location.directory, "telemetry-state")),
  ).toEqual({ pruned: 1, unreadable: 1 });
  expect(readdirSync(folder)).toEqual([
    "00000000-0000-4000-8000-000000000000.bin",
  ]);
});
