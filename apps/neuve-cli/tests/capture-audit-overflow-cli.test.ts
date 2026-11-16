// Legacy count values must fail one capture without hiding later captures in the audit.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Log, mintUlid, storeLocationIn } from "@neuve/records-core";
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

test("audit --all reports a legacy overflow-count filing and audits the later capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-overflow-walk-"));
  try {
    const location = storeLocationIn(join(root, "store")),
      run = runIn(location);
    const captures: string[] = [];
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
      if (id === "first") {
        const row = value(await run(CaptureRecords.rawCaptures()))[0]!;
        if (row._tag === "Invalid") throw new Error(row.reason);
        const event = row.event;
        const crafted = {
          ...event,
          id: mintUlid(),
          idempotencyKey: `capture.filed:${captures[0]}:old-overflow`,
          payload: {
            ...event.payload,
            runId: "crafted",
            counts: {
              ...event.payload.counts,
              records: Number.MAX_SAFE_INTEGER,
            },
          },
        };
        expect(Exit.isFailure(await run(Log.append([crafted])))).toBe(true);
        value(
          await run(
            Effect.flatMap(
              SqlClient,
              (sql) =>
                sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${crafted.id},kind,${crafted.idempotencyKey},fingerprint,actor_id,occurred_at,recorded_at,${JSON.stringify(crafted)} FROM events WHERE id=${event.id}`,
            ),
          ),
        );

        for (const envelope of [
          JSON.stringify({
            ...crafted,
            payload: {
              ...crafted.payload,
              counts: { ...crafted.payload.counts, records: "invalid" },
            },
          }),
          "{",
        ])
          value(
            await run(
              Effect.flatMap(
                SqlClient,
                (sql) =>
                  sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${mintUlid()},kind,${`capture.filed:${mintUlid()}`},fingerprint,actor_id,occurred_at,recorded_at,${envelope} FROM events WHERE id=${event.id}`,
              ),
            ),
          );
      }
    }
    for (const repair of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../src/cli.ts"),
          "review",
          "audit",
          "--all",
          ...(repair ? ["--repair"] : []),
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
      expect(results).toHaveLength(5);
      expect(results[1]).toMatchObject({
        rawCapture: captures[0],
        observed: "failed",
        reason: "invalid capture scan counts; export refused",
        retryable: false,
      });
      expect(results[2]).toMatchObject({
        observed: "failed",
        reason: "invalid capture filing; export refused",
        retryable: false,
      });
      expect(results[3]).toMatchObject({
        observed: "failed",
        reason: "invalid capture filing; export refused",
        retryable: false,
      });
      expect(results[4]).toMatchObject({
        rawCapture: captures[1],
        observed: "clean",
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
