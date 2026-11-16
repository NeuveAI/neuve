// A review wait may outlive the old age cutoff; only the owning attempt's liveness decides cleanup.
import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { JobQueue, storeLocationIn } from "@neuve/records-core";
import { captureCheckpointSweep } from "../../../src/pi/capture/retention.ts";
import { createCaptureStaging } from "../../../src/pi/capture/staging.ts";
import { runIn, value } from "./fixture.ts";
const root = mkdtempSync(join(tmpdir(), "capture-staging-proof-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a live scan attempt keeps old staging; recovered and dead owners are removed immediately", async () => {
  const location = storeLocationIn(join(root, "store"));
  const run = runIn(location);
  const job = value(
    await run(
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        yield* queue.enqueue({
          kind: "capture.scan",
          dedupeKey: "staging-fixture",
          payload: {},
        });
        const held = yield* queue.take(["capture.scan"]);
        if (held._tag !== "Some")
          throw new Error("fixture job was not claimed");
        return held.value;
      }).pipe(Effect.provide(JobQueue.layer)),
    ),
  );
  const directory = join(location.directory, "capture-jobs");
  mkdirSync(directory, { recursive: true });
  const live = createCaptureStaging(join(directory, "job-"), {
    seq: job.seq,
    attempt: job.attempts,
  });
  const recovered = createCaptureStaging(join(directory, "job-"), {
    seq: job.seq,
    attempt: job.attempts + 1,
  });
  const orphan = join(directory, "job-orphan");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "private-copy"), "synthetic raw bytes");
  utimesSync(live, new Date(0), new Date(0));
  const sweep = captureCheckpointSweep(location);
  value(await run(sweep.sweep));
  expect([existsSync(live), existsSync(recovered), existsSync(orphan)]).toEqual(
    [true, false, false],
  );
  value(
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`UPDATE jobs SET state='waiting' WHERE job_seq=${job.seq}`;
      }),
    ),
  );
  value(await run(sweep.sweep));
  expect(existsSync(live)).toBe(false);
});
