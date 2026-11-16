// An old row's clock overflow must leave its failed scan status visible to an operator.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Computations,
  JobQueue,
  Worker,
  storeLocationIn,
  canonicalJson,
  mintUlid,
} from "@neuve/records-core";
import {
  captureRunDump,
  openCaptureJournal,
  CaptureRecords,
  captureScanHandler,
} from "@neuve/harness/session-dump";
import { fingerprintOf } from "../../../packages/records-core/src/codec.ts";
import {
  runIn,
  value,
} from "../../../packages/harness/tests/pi/capture/fixture.ts";
test("capture-status reports the failed legacy overflow attempt with a fallback ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-old-status-"));
  try {
    const location = storeLocationIn(join(root, "store")),
      run = runIn(location);
    const journal = openCaptureJournal(join(root, "journal"), "oldstatus");
    journal.capture({
      type: "run.start",
      scope: { runId: "oldstatus" },
      runKind: "scored",
      sourceRevision: "a".repeat(40),
      route: "openai",
      pricing: "subscription",
    });
    journal.close();
    const raw = value(
      await run(
        captureRunDump({ runId: "oldstatus", journal: journal.directory }),
      ),
    );
    value(
      await run(
        Effect.gen(function* () {
          const row = (yield* CaptureRecords.rawCaptures())[0];
          if (row?._tag !== "Filed") return yield* Effect.die("missing filing");
          const event = {
            ...row.event,
            id: mintUlid(),
            idempotencyKey: `capture.filed:legacy:${raw.capture}`,
            payload: {
              ...row.event.payload,
              counts: {
                ...row.event.payload.counts,
                records: Number.MAX_SAFE_INTEGER,
              },
            },
          };
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES (${event.id},${event.kind},${event.idempotencyKey},${fingerprintOf(event)},${event.actor},${event.occurredAt},${event.occurredAt},${canonicalJson(event)})`;
          yield* sql`UPDATE jobs SET event_id=${event.id} WHERE event_id=${row.event.id}`;
          yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "capture.scan": captureScanHandler({
                location,
                command: ["must-not-spawn"],
              }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "capture-status",
        "--capture",
        raw.capture,
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
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      status: "failed",
      reason: "invalid capture scan counts; export refused",
      ceilingMs: 1800000,
    });
    expect(err).toContain(
      "capture ceiling fallback: capture close failed (private details suppressed)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
