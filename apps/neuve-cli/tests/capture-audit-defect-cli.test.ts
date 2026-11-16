// Defects at the scan boundary must become one public result while later captures are audited.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storeLocationIn } from "@neuve/records-core";
import {
  captureRunDump,
  openCaptureJournal,
} from "@neuve/harness/session-dump";
import {
  runIn,
  value,
} from "../../../packages/harness/tests/pi/capture/fixture.ts";

test("an audit defect produces a public failed result and the walk audits the next capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-walk-defect-"));
  try {
    const location = storeLocationIn(join(root, "store"));
    const captures = [];
    for (const runId of ["first", "second"]) {
      const journal = openCaptureJournal(join(root, runId), runId);
      journal.capture({
        type: "run.start",
        scope: { runId },
        runKind: "scored",
        sourceRevision: "a".repeat(40),
        route: "openai",
        pricing: "subscription",
      });
      journal.capture({
        type: "run.end",
        scope: { runId },
        status: "completed",
      });
      journal.close();
      captures.push(
        value(
          await runIn(location)(
            captureRunDump({ runId, journal: journal.directory }),
          ),
        ).capture,
      );
    }
    const preload = join(root, "preload.ts");
    writeFileSync(
      preload,
      `import {plugin} from "bun";plugin({name:"walk-defect",setup(build){build.onLoad({filter:/harness\\/src\\/pi\\/capture\\/audit\\.ts$/},async args=>{
    const source=await Bun.file(args.path).text();
    const needle="    const rawCapture = input.event.payload.rawCapture;";
    if(!source.includes(needle)) throw new Error("test patch missing");
    return {loader:"ts",contents:source.replace(needle,needle+'\\n    if(input.event.payload.runId === "first") return yield* Effect.die(new Error("synthetic-private-walk-defect"));')};
  });}});`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--all",
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, err).toBe(2);
    expect(JSON.parse(out)).toEqual([
      expect.objectContaining({
        rawCapture: captures[0],
        observed: "failed",
        reason: "capture close failed (private details suppressed)",
        retryable: false,
      }),
      expect.objectContaining({ rawCapture: captures[1], observed: "clean" }),
    ]);
    expect(out).not.toContain("synthetic-private-walk-defect");
    expect(err).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
