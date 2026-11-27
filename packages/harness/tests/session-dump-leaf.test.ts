// Why: evaluation and the CLI read and file session dumps through `@neuve/harness/session-dump`
// without loading the harness's index or model loop. This drives the leaf by its package name the
// way they will: a coding session's journal filed straight to a folder, read back with the leaf's
// Effect reader, then refiled in its portable form.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  CAPTURE_VERSION,
  DUMP_FORMAT,
  exportPortableSnapshot,
  exportSnapshot,
  fullOutputPath,
  openCaptureJournal,
  readSessionDump,
  type CaptureJournal,
  type JournalOptions,
} from "@neuve/harness/session-dump";
import { captureAuthority } from "./pi/capture/fixture.ts";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "harness-session-dump-leaf-")),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("the public leaf files, reads and derives a session dump by its package name", async () => {
  const source = join(directory, "channel");
  const journal = join(source, "capture");
  const scope = { runId: "leaf-channel" };
  const options: JournalOptions = {};
  const capture: CaptureJournal = openCaptureJournal(
    journal,
    scope.runId,
    options,
  );
  expect(
    fullOutputPath([
      { code: "full_output", message: "Full output: /fixture/output.log" },
    ]),
  ).toBe("/fixture/output.log");
  capture.capture({
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: { status: "not-applicable", reason: "no repository" },
    route: "chatgpt",
    pricing: "subscription",
  });
  capture.capture({ type: "run.end", scope, status: "completed" });
  capture.close();
  const root = join(directory, "datasets");
  mkdirSync(root);
  const retention = { policy: "leaf fixture" };
  using authority = captureAuthority(source);
  const filed = await exportSnapshot({
    credentialInspection: authority.inspection,
    runId: scope.runId,
    journal,
    root,
    retention,
  });
  const read = await Effect.runPromise(readSessionDump(filed.directory));
  expect([DUMP_FORMAT, CAPTURE_VERSION]).toEqual(["neuve.session-dump", 1]);
  expect(read.manifest).toMatchObject({
    format: "neuve.session-dump",
    runId: "leaf-channel",
    runKind: "coding",
    redaction: "restricted",
  });
  expect(read.run).toMatchObject({
    execution: "ended",
    complete: true,
    gaps: [],
    backup: {
      status: "unavailable",
      reason: "no native SQLite database was named for this capture",
    },
  });
  const portable = await exportPortableSnapshot({
    directory: filed.directory,
    root,
    retention,
  });
  expect(portable.directory).toBe(
    join(root, "portable", "coding", "leaf-channel", filed.snapshotId),
  );
});
