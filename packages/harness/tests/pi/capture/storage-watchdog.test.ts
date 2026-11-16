// Cancellation after the build must still leave the actual close diagnostic at both I/O boundaries.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Blobs, storeLocationIn } from "@neuve/records-core";
import {
  captureRunDump,
  sealCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  withProgressWatchdog,
  NO_PROGRESS_REASON,
} from "../../../src/pi/capture/watchdog.ts";
import { runIn, value } from "./fixture.ts";
for (const boundary of ["put", "get"] as const)
  test(`no progress during blob ${boundary} persists the close diagnostic`, async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-storage-watch-"));
    try {
      const location = storeLocationIn(join(root, "store"));
      const run = runIn(location);
      const journal = join(root, "capture");
      const log = openCaptureJournal(journal, "storage");
      log.capture({
        type: "run.start",
        scope: { runId: "storage" },
        runKind: "scored",
        sourceRevision: "a".repeat(40),
        route: "openai",
        pricing: "subscription",
      });
      log.capture({
        type: "run.end",
        scope: { runId: "storage" },
        status: "completed",
      });
      log.close();
      const raw = value(
        await run(captureRunDump({ runId: "storage", journal })),
      );
      let entered = false;
      const result = value(
        await run(
          Effect.gen(function* () {
            const blobs = yield* Blobs.BlobStore;
            const blocked = {
              ...blobs,
              [boundary]: () =>
                Effect.andThen(
                  Effect.sync(() => {
                    entered = true;
                  }),
                  Effect.never,
                ),
            };
            const fiber = yield* Effect.forkChild(
              withProgressWatchdog((progress, signal) =>
                sealCapturedDump(
                  { runId: "storage", journal, progress, signal },
                  { rawCapture: raw.capture, policy: "capture-scan-v1" },
                ),
              ).pipe(
                Effect.result,
                Effect.provideService(Blobs.BlobStore, blocked),
              ),
            );
            yield* Effect.promise(async () => {
              for (let i = 0; i < 500 && !entered; i++) await Bun.sleep(10);
              if (!entered) throw new Error("storage boundary not reached");
            });
            yield* TestClock.adjust("38 seconds");
            return yield* Fiber.join(fiber);
          }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ScanNoProgress" },
      });
      expect(
        JSON.parse(readFileSync(join(journal, "close-diagnostic.json"), "utf8"))
          .refusal,
      ).toBe(NO_PROGRESS_REASON);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
