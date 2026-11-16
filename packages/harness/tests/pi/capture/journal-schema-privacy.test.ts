import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { exportSnapshot } from "../../../src/session-dump.ts";

test("a corrupt original frame refuses without echoing an unknown credential-shaped property name", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-schema-private-"));
  try {
    const journal = join(root, "journal");
    mkdirSync(journal);
    mkdirSync(join(root, "datasets"));
    const secret = "synthetic-historical-unknown-property";
    writeFileSync(
      join(journal, "events.jsonl"),
      JSON.stringify({
        v: 1,
        seq: 1,
        at: 0,
        event: { type: "journal.open", scope: { runId: "synthetic" } },
        [secret]: "invalid",
      }) + "\n",
    );
    expect(readCaptureJournal(journal)).toEqual({
      _tag: "Corrupt",
      line: 1,
      reason: "journal frame schema is invalid",
    });
    const failed = await exportSnapshot({
      runId: "synthetic",
      journal,
      root: join(root, "datasets"),
      retention: { policy: "synthetic" },
    }).catch((error: unknown) => error);
    expect(failed).toMatchObject({
      _tag: "DumpFailed",
      reason: "capture journal line 1: journal frame schema is invalid",
    });
    expect(JSON.stringify(failed)).not.toContain(secret);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
