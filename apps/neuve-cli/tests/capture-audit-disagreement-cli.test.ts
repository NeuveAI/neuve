import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storeLocationIn } from "@neuve/records-core";
import {
  captureRunDump,
  openCaptureJournal,
  CaptureRecords,
} from "@neuve/harness/session-dump";
import {
  runIn,
  value,
  scanCaptures,
} from "../../../packages/harness/tests/pi/capture/fixture.ts";

test("audit exit status reports disagreements even when the requested repair succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-audit-compliance-"));
  try {
    const location = storeLocationIn(join(root, "store")),
      run = runIn(location),
      journal = openCaptureJournal(join(root, "capture"), "disagreement");
    journal.capture({
      type: "run.start",
      scope: { runId: "disagreement" },
      runKind: "scored",
      sourceRevision: "a".repeat(40),
      route: "openai",
      pricing: "subscription",
    });
    journal.capture({
      type: "run.end",
      scope: { runId: "disagreement" },
      status: "completed",
    });
    journal.close();
    const raw = value(
      await run(
        captureRunDump({ runId: "disagreement", journal: journal.directory }),
      ),
    );
    value(await run(scanCaptures(location)));
    const mark = value(await run(CaptureRecords.markFor(raw.capture)))!;
    value(
      await run(
        CaptureRecords.appendMark(
          {
            ...mark.payload,
            outcome: "refused",
            reason:
              "credential exposure in exact source; source retained privately, export refused",
          },
          mark.id,
        ),
      ),
    );
    for (const [repair, expected, disagrees] of [
      [false, 2, true],
      [true, 2, true],
      [false, 0, false],
    ] as const) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../src/cli.ts"),
          "review",
          "audit",
          "--capture",
          raw.capture,
          ...(repair ? ["--repair"] : []),
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
      expect(code, err).toBe(expected);
      expect(JSON.parse(out)[0]).toMatchObject({ disagrees, repaired: repair });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
