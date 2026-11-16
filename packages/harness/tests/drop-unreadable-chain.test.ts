// Why: a drop must always leave its gap, even when the new chain cannot be read. A review dropped
// mid-Publish asks the new publisher which batches it appended that no packet names; when that
// chain's stored bytes are damaged, the drop used to fail and write no gap at all, after the job
// was already dropped and its run folder gone. These reproduce it through `dropActiveJob`: a
// publication stopped after its batches, its stored plan's bytes then overwritten, and a worker
// socket that answers `dropping` for a review job left waiting. Binding that socket needs a host
// that allows it; the Claude sandbox does not, so there the tests are skipped.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { JobQueue, Log, Worker, mintUlid } from "@neuve/records-core";
import { dropActiveJob } from "../src/handler.ts";
import {
  publishSettledForTest,
  unpublishedBatches,
} from "../src/publish-sections.ts";
import { openRunLog } from "../src/run-log.ts";
import { inputOf, scratch, threeBatches } from "./publish-sections-fixtures.ts";

const canBind = (() => {
  const directory = mkdtempSync(join(tmpdir(), "harness-drop-probe-"));
  mkdirSync(directory, { recursive: true });
  try {
    const server = Bun.listen({
      unix: join(directory, "probe.sock"),
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();
if (!canBind)
  console.warn(
    "drop-unreadable-chain.test.ts: this host forbids binding Unix sockets (sandbox); the tests are skipped",
  );

const RUN_KEY = "c".repeat(64);

test.skipIf(!canBind).each([
  ["without an old-style batch", false],
  ["with an old-style batch", true],
] as const)(
  "a drop whose new chain cannot be read still writes its one gap (%s)",
  async (_label, oldStyle) => {
    const store = scratch();
    const { location, cycleId } = store;
    const runId = mintUlid();
    const range = {
      baseRef: "main",
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
    };
    const { a } = threeBatches();
    let oldBatchId = "";
    const unpublishedBefore = await store.run(
      Effect.gen(function* () {
        // The request enqueues its review job, left waiting: no worker runs it.
        yield* Log.append([
          {
            id: runId,
            kind: "review.requested@1",
            idempotencyKey: `review:${runId}`,
            actor: "a".repeat(64),
            occurredAt: new Date().toISOString(),
            attribution: { cycleId, range },
            payload: {
              runKey: RUN_KEY,
              generation: 0,
              pipeline: { version: 1, config: {} },
            },
          },
        ]);
        if (oldStyle) {
          // The old publisher's batch, after the run's first start and with no packet.
          openRunLog(location, runId).write({ type: "run.started" });
          oldBatchId = mintUlid();
          yield* Log.append([
            {
              id: oldBatchId,
              kind: "batch.recorded@1",
              idempotencyKey: `review:${cycleId}:${RUN_KEY}:batch:b1#0123456789abcdef`,
              actor: "a".repeat(64),
              occurredAt: new Date().toISOString(),
              attribution: { cycleId, batchId: mintUlid() },
              payload: { title: "Batch one", focus: "f" },
            },
          ]);
        }
        // The new publisher, stopped after its batches: a plan stored, a batch appended, no packet.
        yield* Effect.exit(
          publishSettledForTest(
            store.ctx({ runId, runKey: RUN_KEY, range }),
            inputOf([a]),
            "batches",
          ),
        );
        const before = yield* unpublishedBatches({
          cycleId,
          runKey: RUN_KEY,
          runId,
        });
        // Damage the stored plan's bytes, past the scratch store's guard on blobs.
        const sql = yield* SqlClient;
        yield* sql.unsafe("DROP TRIGGER blobs_guarded_update");
        yield* sql`UPDATE blobs SET content = X'00000000' WHERE hash IN (
          SELECT output_hash FROM computations WHERE op = 'harness.publication')`;
        const [damaged] = yield* sql<{ n: number }>`SELECT count(*) AS n
          FROM blobs WHERE content = X'00000000'`;
        expect(damaged?.n).toBe(1);
        return before;
      }),
    );
    // Readable, the chain names this run's one new batch.
    expect(unpublishedBefore).toHaveLength(1);
    const unreadable = await store.run(
      Effect.exit(unpublishedBatches({ cycleId, runKey: RUN_KEY, runId })),
    );
    expect(unreadable._tag).toBe("Failure");

    const job = await store.run(
      JobQueue.JobQueue.use((queue) => queue.inspect(1)).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.provide(JobQueue.layer),
      ),
    );
    expect(job?.kind).toBe("review.run@2");
    expect(job?.state).toBe("waiting");
    expect(job?.eventId).toBe(runId);

    const socket = await Effect.runPromise(Worker.socketPathFor(location));
    const commands: Array<string> = [];
    const server = Bun.listen({
      unix: socket,
      socket: {
        data(connection, data) {
          commands.push(String(data).trim());
          connection.write("dropping\n");
        },
      },
    });
    try {
      const result = await store.run(
        dropActiveJob(location, 1).pipe(Effect.provide(JobQueue.layer)),
      );
      expect(commands).toEqual(["drop 1"]);
      expect(result.dropped).toBe(true);
      const named = oldStyle ? [`b1 (${oldBatchId})`] : [];
      expect(result.dropped && result.interrupted).toEqual(named);
      const gaps = await store.run(
        Log.history({ kind: "gap.disclosed@1", limit: 10 }),
      );
      expect(
        gaps.map((g) =>
          g.event.kind === "gap.disclosed@1" ? g.event.payload : undefined,
        ),
      ).toEqual([
        {
          kind: "publish-interrupted",
          detail: oldStyle
            ? "Publishing stopped partway: 1 batch(es) were saved, but no published review includes them."
            : "Publishing may have stopped partway; which batches were saved could not be read.",
        },
      ]);
      // The run log says the chain could not be read, as a closed label, never the error's message.
      const logged = openRunLog(location, runId)
        .read()
        .filter((record) => record.type === "gap");
      expect(logged).toEqual([
        expect.objectContaining({
          kind: "publish-interrupted",
          cause: oldStyle
            ? `the new publisher's chain could not be read; b1 (${oldBatchId})`
            : "the new publisher's chain could not be read",
        }),
      ]);
    } finally {
      server.stop(true);
    }
  },
  30_000,
);
