// The outer child catch must still produce a valid reply, including the non-retryable prune kind.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import {
  runScanProcess,
  ScanMachineBudget,
} from "../../../src/pi/capture/process.ts";
import { captureFiledEvent } from "../../../src/pi/capture/records.ts";
import {
  scanMemoryGrant,
  machineInspectionInputs,
} from "../../../src/pi/capture/inspection-pool.ts";
import { runIn, value } from "./fixture.ts";
for (const error of [
  'new RawCapturePruned({reason:"raw capture pruned on 2026-11-02T00:00:00.000Z"})',
  'new Blobs.BlobPruned({hash:"a".repeat(64),prunedAt:"2026-11-02T00:00:00.000Z"})',
])
  test(`outer child ${error.split("(")[0]} preserves the prune reply`, async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-outer-failure-"));
    try {
      const location = storeLocationIn(join(root, "store"));
      value(await runIn(location)(Effect.void));
      const preload = join(root, "preload.ts");
      writeFileSync(
        preload,
        `import {plugin} from "bun";plugin({name:"outer-prune",setup(build){build.onLoad({filter:/harness\\/src\\/pi\\/capture\\/child\\.ts$/},async args=>{
   const source=await Bun.file(args.path).text(),needle="  const program = Effect.gen(function* () {";
   if(!source.includes(needle))throw new Error("fixture patch missing");
   return {loader:"ts",contents:source.replace(needle,needle+${JSON.stringify(`\n    throw ${error};`)})};
  });}});`,
      );
      const cli = fileURLToPath(
        new URL("../../../../../apps/neuve-cli/src/cli.ts", import.meta.url),
      );
      const result = await Effect.runPromise(
        runScanProcess({
          location,
          command: [
            process.execPath,
            "--no-env-file",
            "--preload",
            preload,
            cli,
          ],
          event: captureFiledEvent({
            rawCapture: "a".repeat(64),
            runId: "outer",
            checkpoint: null,
            counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
            sizes: { total: 1, largest: 1 },
          }),
        }).pipe(
          Effect.result,
          Effect.provideService(ScanMachineBudget, (sizes) =>
            scanMemoryGrant(sizes, {
              ...machineInspectionInputs(),
              available: 8 * 1024 ** 3,
            }),
          ),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          failureKind: "pruned",
          reason: "raw capture pruned on 2026-11-02T00:00:00.000Z",
          retryable: false,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
