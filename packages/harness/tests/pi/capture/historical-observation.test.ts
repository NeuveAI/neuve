import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { historicalEvidence } from "../../../src/pi/providers/credential-evidence.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "historical-observation-")),
    source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const owner = SourceOwnership.acquire(source);
  const authority = createPrivateInspection({
    ownership: owner,
    source,
    directory: join(root, "private"),
    excludedRoots: [source],
  });
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => owner.release(),
    () => authority.close(),
  );
  for (const [id, key] of [
    ["old", "synthetic-original"],
    ["new", "synthetic-current"],
  ]) {
    const result = await authority.register({
      epoch: CredentialEpochId.parse(id),
      headers: new Headers({ authorization: `Bearer ${key}` }),
      budget: new InspectionBudget(),
    });
    expect(result.status).toBe("registered");
  }
  return { source, authority };
};

test("historical masking rebuilds nested token coordinates, duplicates and overlapping full-header matches", async () => {
  const { authority } = await fixture();
  const observed: string[] = [];
  const result = await historicalEvidence(
    {
      nested:
        '{"value":"\\u0073ynthetic-original","value":"safe","other":"Bearer synthetic-current twice synthetic-current"}',
    },
    authority,
    (ids) => observed.push(...ids),
  );
  expect(observed.toSorted()).toEqual(["new", "old"]);
  expect(result.data).toEqual({
    nested:
      '{"value":"[REDACTED]","value":"safe","other":"[REDACTED] twice [REDACTED]"}',
  });
});

test("a match observed before later cancellation is synchronously journaled before unavailable escapes", async () => {
  const { source, authority } = await fixture();
  const journal = openCaptureJournal(join(source, "capture"), "synthetic");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await expect(
    historicalEvidence(
      { value: "synthetic-original " + "x".repeat(1024 * 1024) },
      authority,
      (epochs) => {
        for (const callId of epochs)
          journal.capture({
            type: "credential.guard",
            scope: { runId: "synthetic" },
            callId,
            status: "exposed",
          });
      },
      controller.signal,
    ),
  ).rejects.toThrow("unavailable");
  const kept = readCaptureJournal(journal.directory);
  expect(kept._tag).toBe("Read");
  if (kept._tag !== "Read") throw new Error("fixture journal missing");
  expect(
    kept.lines.some(
      ({ event }) =>
        event.type === "credential.guard" &&
        event.callId === "old" &&
        event.status === "exposed",
    ),
  ).toBe(true);
  journal.close();
});
