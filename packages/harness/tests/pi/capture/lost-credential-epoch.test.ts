// A restricted dump must inspect whole calls against the epoch of a lost call.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { storeLocationIn } from "@neuve/records-core";
import { runIn, value } from "./fixture.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  exportPortableSnapshot,
  exportSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";
import {
  JOURNAL_FILE,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { fileRawCapture, scanRawCapture } from "../../../src/pi/capture/raw.ts";
import { sealCapturedDump } from "../../../src/pi/capture/export.ts";

for (const variant of ["covered", "missing", "exposed"] as const) {
  test(`a lost call with ${variant} credential coverage in a restricted dump`, async () => {
    const root = mkdtempSync(join(tmpdir(), "lost-credential-epoch-"));
    const source = join(root, "source");
    const datasets = join(root, "datasets");
    mkdirSync(source);
    mkdirSync(datasets);
    const ownership = SourceOwnership.acquire(source);
    const authority = createPrivateInspection({
      ownership,
      source,
      directory: join(root, "private"),
      excludedRoots: [source, datasets],
    });
    const nativeDatabase = join(source, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    try {
      const secret = "synthetic-credential-for-lost-call";
      const lostCall = randomUUID();
      const registration = await authority.register({
        epoch: CredentialEpochId.parse(
          variant === "missing" ? randomUUID() : lostCall,
        ),
        headers: new Headers({ authorization: `Bearer ${secret}` }),
        budget: new InspectionBudget(),
      });
      expect(registration.status).toBe("registered");
      const runId = "lost-credential-epoch";
      const scope = { runId };
      const journal = openCaptureJournal(join(source, "capture"), runId);
      journal.capture({
        type: "run.start",
        scope,
        runKind: "coding",
        sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
        route: "synthetic",
        pricing: "subscription",
      });
      journal.capture.recordLoss?.(
        {
          callId: lostCall,
          event: "credential.registration",
          kind: "io",
          reason: "permission denied",
          at: new Date().toISOString(),
          credentialCoverage: "required",
        },
        false,
      );
      for (const callId of ["first", "second"]) {
        journal.capture({
          type: "model.request",
          scope,
          callId,
          route: "synthetic",
          provider: "synthetic",
          model: "synthetic",
          headerNames: [],
          credentialCoverage: "none",
          body: {
            status: "sent",
            json: { text: variant === "exposed" ? secret : callId },
          },
        });
        journal.capture({ type: "model.response", scope, callId, status: 200 });
        journal.capture({
          type: "model.end",
          scope,
          callId,
          outcome: "completed",
        });
      }
      journal.capture({ type: "run.end", scope, status: "completed" });
      journal.close();
      chmodSync(join(journal.directory, JOURNAL_FILE), 0o400);
      const retention = { policy: "synthetic" };
      const exported = exportSnapshot({
        runId,
        journal: journal.directory,
        nativeDatabase,
        credentialInspection: authority,
        root: datasets,
        retention,
      });
      if (variant === "exposed" || variant === "missing") {
        await expect(exported).rejects.toThrow(
          variant === "exposed"
            ? "credential exposure in exact source"
            : "credential registration was lost and the scan could not identify the credential",
        );
        return;
      }
      const snapshot = await exported;
      const dump = await Effect.runPromise(readSessionDump(snapshot.directory));
      expect(dump.run.complete).toBe(false);
      expect(
        dump.run.gaps.find(({ code }) => code === "journal-failed"),
      ).toMatchObject({
        count: 1,
        detail: expect.stringContaining(
          `call ${lostCall} lost capture at credential.registration`,
        ),
      });
      expect(dump.run.journal.status).toBe("captured");
      expect(dump.run.gaps.map(({ code }) => code)).toEqual([
        "journal-failed",
        "calls-unjoined",
      ]);
      expect(
        dump.unjoined.map(({ callId, end }) => [callId, end?.outcome]),
      ).toEqual([
        ["first", "completed"],
        ["second", "completed"],
      ]);
      const portable = await exportPortableSnapshot({
        directory: snapshot.directory,
        root: datasets,
        retention,
      });
      const copy = await Effect.runPromise(readSessionDump(portable.directory));
      expect(copy.run.gaps).toEqual(dump.run.gaps);
      expect(copy.unjoined.map(({ callId }) => callId)).toEqual([
        "first",
        "second",
      ]);
      const location = storeLocationIn(join(root, "records"));
      const run = runIn(location);
      const filed = value(
        await run(
          fileRawCapture({
            runId,
            journal: journal.directory,
            nativeDatabase,
            credentialInspection: authority,
          }),
        ),
      );
      const { backup } = dump.run;
      if (backup.status !== "captured") throw new Error("Expected a backup");
      expect(filed.manifest.checkpoint?.nativeSha256).toBe(backup.sha256);
      const scanned = value(
        await run(
          scanRawCapture({
            location,
            rawCapture: filed.rawCapture,
            seal: (sources, scan) => sealCapturedDump(sources, scan, false),
          }),
        ),
      );
      expect(scanned.run.gaps).toEqual(dump.run.gaps);
      expect(scanned.run.journal).toEqual(dump.run.journal);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      authority.close();
      ownership.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
