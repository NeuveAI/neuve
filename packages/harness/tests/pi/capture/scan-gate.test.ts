// The real worker must not start a scan inside either review of a batch, even after async preparation.
import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import {
  runScanProcess,
  ScanMachineBudget,
} from "../../../src/pi/capture/process.ts";
import {
  scanMemoryGrant,
  machineInspectionInputs,
} from "../../../src/pi/capture/inspection-pool.ts";
import { captureFiledEvent } from "../../../src/pi/capture/records.ts";
import { runIn, value } from "./fixture.ts";

test("real heavy-work gate rechecks after asynchronous preparation and batch review wakeups", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-real-gate-")),
    location = storeLocationIn(join(root, "store"));
  const script = join(root, "child.ts");
  writeFileSync(
    script,
    `process.stdout.write('{"type":"failure","failureKind":"execution","reason":"capture scan failed; retry later","retryable":true}\\n');`,
  );
  let reviewing = false,
    starts = 0,
    observations = 0;
  const launches: boolean[] = [];
  const original = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation((...args) => {
    if (Array.isArray(args[0]) && args[0].includes("capture-scan"))
      launches.push(reviewing);
    return Reflect.apply(original, Bun, args);
  });
  try {
    const exit = value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          for (const key of ["r1", "r2"])
            yield* queue.enqueue({ kind: "review.run", dedupeKey: key });
          yield* queue.enqueue({
            kind: "capture.scan",
            dedupeKey: "scan-batch",
          });
          return yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "review.run": () =>
                Effect.gen(function* () {
                  reviewing = true;
                  starts++;
                  yield* Effect.sleep("600 millis");
                  reviewing = false;
                }),
              "capture.scan": () =>
                runScanProcess({
                  location,
                  command: [process.execPath, "--no-env-file", script],
                  event: captureFiledEvent({
                    rawCapture: "a".repeat(64),
                    runId: "batch",
                    checkpoint: null,
                    counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
                    sizes: { total: 1, largest: 1 },
                  }),
                }).pipe(Effect.catch(() => Effect.void)),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
          Effect.provideService(ScanMachineBudget, async (sizes) => {
            observations++;
            await mkdir(join(root, "freshness"), { recursive: true });
            const dir = await mkdtemp(join(root, "freshness", "read-"));
            await Bun.sleep(40);
            await rm(dir, { recursive: true });
            return scanMemoryGrant(sizes, {
              ...machineInspectionInputs(),
              available: 8 * 1024 ** 3,
            });
          }),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    expect(starts).toBe(2);
    expect(launches).toEqual([false]);
    expect(observations).toBeGreaterThanOrEqual(3);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
