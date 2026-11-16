// Why: adding optional preparation must not turn healthy historical review events into corruption.
import { afterAll, expect, test } from "bun:test";
import { RecordEvent } from "@neuve/records-schema";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Admin, Log, Store, mintUlid, sha256Hex } from "../src/index.ts";
import {
  actor,
  cycleEvents,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
  runFs,
} from "./support.ts";
afterAll(removeTemporaryDirectories);

test("fsck accepts historical review requests without discovery but still requires the review job", async () => {
  const location = freshLocation();
  const cycle = cycleEvents(1);
  const opened = RecordEvent.parse(cycle.events[0]);
  if (opened.kind !== "cycle.opened@1")
    throw new Error("Expected opening event");
  const cycleId = opened.attribution.cycleId;
  await runOn(
    location,
    Log.append([
      ...cycle.events,
      {
        id: mintUlid(),
        kind: "review.requested@1",
        idempotencyKey: "request:historical",
        actor,
        occurredAt: "2026-11-01T10:00:00.000Z",
        attribution: {
          cycleId,
          range: { baseRef: "main", baseOid: "b".repeat(40), headOid },
        },
        payload: {
          runKey: sha256Hex("historical"),
          generation: 0,
          pipeline: { version: 10, config: {} },
        },
      },
    ]),
  );
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM jobs WHERE kind = 'commit.prepare@2'`;
    }),
  );
  const check = async () => {
    const checks = await runFs(
      Admin.fsck(location).pipe(
        Effect.provide(Store.layer(location, { create: false })),
      ),
    );
    return checks.find(
      (row) => row.name === "jobs match the events that enqueue them",
    );
  };
  expect((await check())?.status).toBe("ok");
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM jobs WHERE kind = 'review.run@2'`;
    }),
  );
  expect((await check())?.status).toBe("fail");
});
