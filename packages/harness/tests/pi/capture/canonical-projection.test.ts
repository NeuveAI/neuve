import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  exportSnapshot,
  readSessionDump,
  openCaptureJournal,
} from "@neuve/harness/session-dump";
import { rememberEphemeralCredentials } from "../../../src/pi/capture/safety.ts";

test("generic non-generation credential guards certify exact native sources and preserve exposure refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-generic-guard-"));
  const database = join(directory, "pi.sqlite");
  const storage = await openNodeSqliteStorage(database);
  const root = join(directory, "datasets");
  await mkdir(root);
  const runId = "generic-guard";
  const journal = openCaptureJournal(join(directory, "capture"), runId);
  const capture = journal.capture;
  capture({
    type: "run.start",
    scope: { runId },
    runKind: "reading",
    sourceRevision: "synthetic",
    route: "anthropic",
    pricing: "metered",
  });
  await rememberEphemeralCredentials(
    capture,
    runId,
    "count-request",
    new Headers({ "x-api-key": "SYNTHETIC_COUNT_SECRET" }),
  );
  capture({
    type: "credential.guard",
    scope: { runId },
    callId: "count-request",
    status: "pending",
  });
  capture({
    type: "credential.guard",
    scope: { runId },
    callId: "count-request",
    status: "observed",
  });
  journal.close();
  const input = {
    runId,
    journal: journal.directory,
    native: { reads: storage, context },
    nativeDatabase: database,
    root,
    retention: { policy: "synthetic" },
  };
  try {
    const snapshot = await exportSnapshot(input);
    expect(
      (await Effect.runPromise(readSessionDump(snapshot.directory))).sessions,
    ).toEqual([]);
    const reopened = openCaptureJournal(journal.directory, runId);
    reopened.capture({
      type: "credential.guard",
      scope: { runId },
      callId: "count-request",
      status: "exposed",
    });
    reopened.capture({
      type: "credential.guard",
      scope: { runId },
      callId: "later-clean-count",
      status: "observed",
    });
    reopened.close();
    expect(
      await Effect.runPromise(
        Effect.result(Effect.tryPromise(() => exportSnapshot(input))),
      ),
    ).toHaveProperty("_tag", "Failure");
  } finally {
    await storage.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
