import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import {
  credentialInspection,
  credentialRefusal,
  credentialSourceHash,
  rememberEphemeralCredentials,
} from "../../../src/pi/capture/safety.ts";

test("a later rotated-key inspector cannot clear historical insufficient inspection evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "credential-policy-"));
  const runId = "historical-policy";
  const sourceHashes = ["a".repeat(64)];
  const journal = openCaptureJournal(directory, runId);
  try {
    for (const callId of ["historical", "rotated"]) {
      journal.capture({
        type: "model.request",
        scope: { runId },
        callId,
        route: "local",
        provider: "local",
        model: "local",
        headerNames: ["authorization"],
        credentialCoverage: "required",
        body: { status: "sent", json: {} },
      });
      journal.capture({
        type: "credential.guard",
        scope: { runId },
        callId,
        status: "pending",
      });
      journal.capture({
        type: "credential.guard",
        scope: { runId },
        callId,
        status: "observed",
      });
    }
    journal.capture({
      type: "credential.inspection",
      scope: { runId },
      callId: "historical",
      safe: true,
      version: 2,
      sourceHashes,
      sourceHash: credentialSourceHash(sourceHashes),
    });
    await rememberEphemeralCredentials(
      journal.capture,
      runId,
      "rotated",
      new Headers({ "x-api-key": "different-key" }),
    );
    journal.close();
    const read = readCaptureJournal(directory);
    if (read._tag !== "Read")
      throw new Error("expected readable source journal");
    expect(credentialInspection(runId, read.lines, sourceHashes)).toEqual({
      status: "unavailable",
    });
    expect(credentialRefusal(read.lines, sourceHashes)).toContain(
      "source retained",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
