import { stopStoreWorker } from "../../../packages/records-core/tests/worker-process.ts";
// The owner can recover a squatted repair through send-back; a squatted first attempt ends visibly.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Log, JobQueue, storeLocationIn, mintUlid } from "@neuve/records-core";
import {
  captureRunDump,
  openCaptureJournal,
  CaptureRecords,
  readCapturedDump,
  readRawManifest,
} from "@neuve/harness/session-dump";
import { captureScanHandler } from "../../../packages/harness/src/pi/capture/job.ts";
import { commitEvent } from "../../../packages/records-core/tests/support.ts";
import {
  runIn,
  value,
  scanCaptures,
} from "../../../packages/harness/tests/pi/capture/fixture.ts";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
for (const first of [false, true])
  test(
    first
      ? "a squatted first scan seal fails its attempt and a fresh requeue recovers"
      : "send-back recovers a squatted completed capture through a new attempt seal",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "capture-requeue-conflict-"));
      try {
        const location = storeLocationIn(join(root, "store")),
          run = runIn(location);
        const journal = openCaptureJournal(join(root, "journal"), "synthetic");
        journal.capture({
          type: "run.start",
          scope: { runId: "synthetic" },
          runKind: "scored",
          sourceRevision: "a".repeat(40),
          route: "openai",
          pricing: "subscription",
        });
        journal.capture({
          type: "run.end",
          scope: { runId: "synthetic" },
          status: "completed",
        });
        journal.close();
        const raw = value(
          await run(
            captureRunDump({ runId: "synthetic", journal: journal.directory }),
          ),
        ).capture;
        if (!first) value(await run(scanCaptures(location)));
        const before = value(await run(CaptureRecords.scanStatus(raw)));
        if (!("jobSeq" in before)) throw new Error("missing job");
        const old = value(await run(CaptureRecords.markFor(raw)));
        const key = first
          ? `capture.sealed:${raw}:capture-scan-v1:job:${before.jobSeq}:attempt:1`
          : `capture.sealed:audit:${old!.id}:${"b".repeat(64)}`;
        value(
          await run(
            Effect.gen(function* () {
              const event = commitEvent("8".repeat(40));
              yield* Log.append([event]);
              const sql = yield* SqlClient;
              yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${mintUlid()},kind,${key},fingerprint,actor_id,occurred_at,recorded_at,envelope FROM events WHERE id=${event.id}`;
            }),
          ),
        );
        if (first)
          value(
            await run(
              Effect.gen(function* () {
                const queue = yield* JobQueue.JobQueue;
                const job = Option.getOrThrow(
                  yield* queue.take(["capture.scan"]),
                );
                const result = yield* captureScanHandler({
                  location,
                  command: [process.execPath, "--no-env-file", cli],
                })(job).pipe(Effect.result);
                expect(result._tag).toBe("Failure");
                if (result._tag === "Success")
                  return yield* Effect.die("expected conflict");
                expect(result.failure).toMatchObject({
                  retryable: false,
                  reason: "capture scan mark has an idempotency conflict",
                });
                yield* queue.fail(job.seq, job.attempts, {
                  tag: "ScanAttemptFailed",
                  message: "capture scan mark has an idempotency conflict",
                  final: true,
                });
              }).pipe(Effect.provide(JobQueue.layer)),
            ),
          );
        const blocked = value(await run(CaptureRecords.scanStatus(raw)));
        expect(blocked.status).toBe(first ? "failed" : "refused");
        expect(blocked).toMatchObject({
          rawCapture: raw,
          jobSeq: before.jobSeq,
        });
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            cli,
            "review",
            "dead-letter",
            "send-back",
            "--job",
            String(before.jobSeq),
            "--store",
            location.directory,
          ],
          {
            env: { ...process.env, HOME: root, TMPDIR: root },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, err).toBe(0);
        expect(JSON.parse(out)[0].seq).toBeGreaterThan(before.jobSeq!);
        for (let n = 0; n < 300; n++) {
          const state = value(await run(CaptureRecords.scanStatus(raw)));
          if (state.status === "clean") break;
          await Bun.sleep(50);
        }
        const status = value(await run(CaptureRecords.scanStatus(raw)));
        expect(status.status).toBe("clean");
        const mark = value(await run(CaptureRecords.markFor(raw)))!;
        expect(mark.idempotencyKey).toContain(":job:");
        if (old) expect(mark.causation?.supersedes).toBe(old.id);
        value(await run(readCapturedDump(raw)));
        const history = value(
          await run(
            Effect.gen(function* () {
              const queue = yield* JobQueue.JobQueue;
              return Option.getOrThrow(yield* queue.inspect(before.jobSeq!));
            }).pipe(Effect.provide(JobQueue.layer)),
          ),
        );
        expect(history.state).toBe(first ? "failed" : "completed");
      } finally {
        const location = storeLocationIn(join(root, "store"));
        await stopStoreWorker(location);
        rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );

test("an older worker dead-letters a squatted bare first seal and send-back recovers with the new worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-legacy-requeue-"));
  const location = storeLocationIn(join(root, "store")),
    run = runIn(location);
  try {
    const journal = openCaptureJournal(join(root, "journal"), "stuck");
    journal.capture({
      type: "run.start",
      scope: { runId: "stuck" },
      runKind: "scored",
      sourceRevision: "a".repeat(40),
      route: "openai",
      pricing: "subscription",
    });
    journal.capture({
      type: "run.end",
      scope: { runId: "stuck" },
      status: "completed",
    });
    journal.close();
    const raw = value(
      await run(captureRunDump({ runId: "stuck", journal: journal.directory })),
    ).capture;
    value(
      await run(
        Effect.gen(function* () {
          const event = commitEvent("9".repeat(40));
          yield* Log.append([event]);
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${mintUlid()},kind,${`capture.sealed:${raw}:capture-scan-v1`},fingerprint,actor_id,occurred_at,recorded_at,envelope FROM events WHERE id=${event.id}`;
        }),
      ),
    );
    const preload = join(root, "legacy-first-key.ts");
    writeFileSync(
      preload,
      `import {plugin} from "bun";plugin({name:"older-seal-key",setup(build){build.onLoad({filter:/harness\\/src\\/pi\\/capture\\/records\\.ts$/},async args=>{
   const source=await Bun.file(args.path).text();const needle="    const root =";
   if(!source.includes(needle))throw new Error("legacy fixture patch missing");
   return {loader:"ts",contents:source.replace(needle,"    attempt = undefined;\\n"+needle)};
  });}});`,
    );
    const worker = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        join(import.meta.dir, "fixtures/capture-scan-worker.ts"),
        location.directory,
        cli,
      ],
      {
        env: { ...process.env, HOME: root, TMPDIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [workerOut, workerErr, workerCode] = await Promise.all([
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
      worker.exited,
    ]);
    expect(workerCode, workerErr).toBe(0);
    expect(workerOut).toContain('"workerExit":"idle"');
    const failed = value(await run(CaptureRecords.scanStatus(raw)));
    expect(failed.status).toBe("failed");
    if (!("jobSeq" in failed)) throw new Error("missing dead-letter job");
    const dead = value(
      await run(
        Effect.flatMap(JobQueue.JobQueue, (q) => q.failedScans(0, 128)).pipe(
          Effect.provide(JobQueue.layer),
        ),
      ),
    );
    expect(dead.map((job) => job.seq)).toEqual([failed.jobSeq!]);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cli,
        "review",
        "dead-letter",
        "send-back",
        "--job",
        String(failed.jobSeq),
        "--store",
        location.directory,
      ],
      {
        env: { ...process.env, HOME: root, TMPDIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)[0].seq).toBeGreaterThan(failed.jobSeq!);
    for (let n = 0; n < 300; n++) {
      if (value(await run(CaptureRecords.scanStatus(raw))).status === "clean")
        break;
      await Bun.sleep(50);
    }
    expect(value(await run(CaptureRecords.scanStatus(raw))).status).toBe(
      "clean",
    );
    value(await run(readCapturedDump(raw)));
  } finally {
    await stopStoreWorker(location);
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
