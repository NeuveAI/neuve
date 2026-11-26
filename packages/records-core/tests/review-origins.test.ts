import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { RecordEvent, type ReviewOrigin } from "@neuve/records-schema";
import {
  Admin,
  Log,
  ReviewOrigins,
  Store,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import {
  actor,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);
const range = {
  baseRef: "main",
  baseOid: "1".repeat(40),
  headOid: "2".repeat(40),
};
const origin: ReviewOrigin = {
  kind: "channel",
  host: "local",
  channel: "channel-one",
  chat: 1,
  lane: "fix",
  items: [
    {
      provider: "github",
      repo: "githubnext/ace",
      kind: "pull-request",
      number: 711,
      url: "https://github.com/githubnext/ace/pull/711",
    },
  ],
};

test("origins preserve many-to-many history through retries, rebuilds and reopen without dispositions", async () => {
  const location = freshLocation();
  const first = mintUlid();
  const second = mintUlid();
  const association = (cycleId: string, value: ReviewOrigin) =>
    envelope(
      "review.origin-recorded@1",
      `origin:${cycleId}:${value.kind === "channel" ? value.channel : "external"}`,
      actor,
      { cycleId, range },
      { identity: sha256Hex(canonicalJson({ cycleId, value })), origin: value },
    );
  const one = association(first, origin);
  const named = {
    ...origin,
    channel: "channel-two",
    display: { project: "limits", branch: "feature/size-limits", base: "main" },
  };
  const two = association(first, named);
  await runOn(
    location,
    Log.append([
      envelope(
        "cycle.opened@1",
        `cycle:${first}`,
        actor,
        { cycleId: first, range },
        {},
      ),
      envelope(
        "cycle.opened@1",
        `cycle:${second}`,
        actor,
        { cycleId: second, range },
        {},
      ),
      one,
      two,
      association(second, origin),
    ]),
  );
  await runExisting(location, Log.append([{ ...one, id: mintUlid() }]));
  const before = await runExisting(
    location,
    ReviewOrigins.list({ channel: "channel-one" }),
  );
  expect(before.map((entry) => entry.reference).sort()).toEqual(
    [first, second].sort(),
  );
  expect(await runExisting(location, ReviewOrigins.cycle(first))).toEqual({
    reference: first,
    base: range.baseOid,
    head: range.headOid,
  });
  expect(
    await runExisting(location, ReviewOrigins.cycle(mintUlid())),
  ).toBeUndefined();
  expect(
    (
      await runExisting(
        location,
        ReviewOrigins.list({ item: origin.items[0]! }),
      )
    ).length,
  ).toBe(3);
  expect(
    (
      await runExisting(
        location,
        ReviewOrigins.list({ channel: "channel-two" }),
      )
    )[0]?.origin,
  ).toEqual(named);
  const rebuilt = await runExisting(location, Admin.rebuild);
  expect(
    (
      await runExisting(
        location,
        ReviewOrigins.list({ channel: "channel-two" }),
      )
    )[0]?.origin,
  ).toEqual(named);
  expect(rebuilt.afterCombined).toBe(rebuilt.beforeCombined);
  expect(
    await runExisting(location, ReviewOrigins.list({ channel: "channel-one" })),
  ).toEqual(before);
  expect(
    await runExisting(
      location,
      Log.history({ kind: "disposition.recorded@1", limit: 20 }),
    ),
  ).toEqual([]);
  expect(
    (
      await runExisting(
        location,
        Log.history({ kind: "review.origin-recorded@1", limit: 20 }),
      )
    ).length,
  ).toBe(3);
});

test("migration preserves an existing event log and runs only once", async () => {
  const location = freshLocation();
  const cycleId = mintUlid();
  const opened = RecordEvent.parse(
    envelope(
      "cycle.opened@1",
      `cycle:${cycleId}`,
      actor,
      { cycleId, range },
      {},
    ),
  );
  await runOn(location, Log.append([opened]));
  await runExisting(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP TABLE projection_review_origins`;
      yield* sql`DELETE FROM records_migrations WHERE migration_id >= 15`;
      yield* sql`UPDATE records_meta SET value = 9 WHERE key = 'projector_version'`;
      yield* sql`UPDATE records_meta SET value = 13 WHERE key = 'min_writer_version'`;
      yield* sql`DELETE FROM records_meta WHERE key = 'projections_version'`;
    }),
  );
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [
      "15_review_origins",
      "16_project_review_origins",
      "17_capture_lookup_indexes",
      "18_computation_operation_index",
      "19_worker_lock_and_job_notices",
      "20_evictable_outputs",
      "21_raw_capture_parts",
    ],
    rebuilt: true,
  });
  expect(await runExisting(location, Store.migrate)).toEqual({
    applied: [],
    rebuilt: false,
  });
  expect(
    (await runExisting(location, Log.history({ limit: 10 })))[0]?.event,
  ).toEqual(opened);
  expect(
    await runExisting(location, ReviewOrigins.list({ channel: "channel-one" })),
  ).toEqual([]);
});
