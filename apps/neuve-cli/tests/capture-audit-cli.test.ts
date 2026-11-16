// A damaged capture cannot hide later captures from an operator's audit walk.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Log, mintUlid, storeLocationIn } from "@neuve/records-core";
import { commitEvent } from "../../../packages/records-core/tests/support.ts";
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

test("audit --all reports a squatted capture and continues to audit the next capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-audit-walk-"));
  try {
    const location = storeLocationIn(join(root, "store")),
      run = runIn(location);
    const captures = [];
    for (const id of ["first", "second"]) {
      const journal = openCaptureJournal(join(root, id), id);
      journal.capture({
        type: "run.start",
        scope: { runId: id },
        runKind: "scored",
        sourceRevision: "a".repeat(40),
        route: "openai",
        pricing: "subscription",
      });
      journal.capture({
        type: "run.end",
        scope: { runId: id },
        status: "completed",
      });
      journal.close();
      captures.push(
        value(
          await run(captureRunDump({ runId: id, journal: journal.directory })),
        ).capture,
      );
      value(await run(scanCaptures(location)));
    }
    const mark = value(await run(CaptureRecords.markFor(captures[0]!)))!;
    const event = commitEvent("7".repeat(40));
    value(await run(Log.append([event])));
    value(
      await run(
        Effect.flatMap(
          SqlClient,
          (sql) =>
            sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${mintUlid()},kind,${`capture.sealed:audit:${mark.id}:${"b".repeat(64)}`},fingerprint,actor_id,occurred_at,recorded_at,envelope FROM events WHERE id=${event.id}`,
        ),
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--all",
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(2);
    const results = JSON.parse(stdout);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      rawCapture: captures[0],
      observed: "failed",
      reason: "capture scan mark has an idempotency conflict",
    });
    expect(results[1]).toMatchObject({
      rawCapture: captures[1],
      observed: "clean",
      disagrees: false,
    });
    const alias = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--capture",
        mark.payload.record,
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [aliasOut, aliasErr, aliasCode] = await Promise.all([
      new Response(alias.stdout).text(),
      new Response(alias.stderr).text(),
      alias.exited,
    ]);
    expect(aliasCode, aliasErr).toBe(2);
    expect(JSON.parse(aliasOut)).toEqual([
      {
        rawCapture: captures[0],
        observed: "failed",
        reason: "capture scan mark has an idempotency conflict",
        retryable: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
