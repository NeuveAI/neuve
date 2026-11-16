// Known stored kinds keep decoding across writer versions, including projection rebuild on open.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { RecordEvent } from "@neuve/records-schema";
import {
  Admin,
  Log,
  canonicalJson,
  PROJECTOR_VERSION,
  mintUlid,
} from "../src/index.ts";
import { fingerprintOf } from "../src/codec.ts";
import { freshLocation, runOn, removeTemporaryDirectories } from "./support.ts";
afterAll(removeTemporaryDirectories);
for (const records of [
  Math.floor(Number.MAX_SAFE_INTEGER / 12) + 1,
  Number.MAX_SAFE_INTEGER,
])
  test(`old filing count ${records} survives history, fsck, rebuild and reopen`, async () => {
    const location = freshLocation();
    const event = RecordEvent.parse({
      id: mintUlid(),
      kind: "capture.filed@1",
      idempotencyKey: `capture.filed:${"a".repeat(64)}`,
      actor: "b".repeat(64),
      occurredAt: new Date().toISOString(),
      payload: {
        rawCapture: "a".repeat(64),
        runId: "legacy",
        checkpoint: null,
        counts: { records, bytes: 1, calls: 0, frames: 1 },
        sizes: { total: 1, largest: 1 },
      },
    });
    await runOn(
      location,
      Effect.gen(function* () {
        const refused = yield* Log.append([event]).pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES (${event.id},${event.kind},${event.idempotencyKey},${fingerprintOf(event)},${event.actor},${event.occurredAt},${event.occurredAt},${canonicalJson(event)})`;
        expect(yield* Log.history({})).toHaveLength(1);
        expect((yield* Log.append([event]))[0]?.status).toBe("existing");
        const checks = yield* Admin.fsck(location);
        expect(
          checks.find((c) => c.name.startsWith("envelopes parse"))?.status,
        ).toBe("ok");
        expect((yield* Admin.rebuild).events).toBe(1);
        yield* sql`UPDATE records_meta SET value=${String(PROJECTOR_VERSION - 1)} WHERE key='projections_version'`;
      }),
    );
    const history = await runOn(location, Log.history({}));
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toEqual(event);
  });

for (const kind of ["sealed", "marked"] as const)
  test(`old capture.${kind} free-text reasons remain readable; new reasons are validated at append`, async () => {
    const location = freshLocation();
    const event = RecordEvent.parse({
      id: mintUlid(),
      kind: `capture.${kind}@1`,
      idempotencyKey: `capture.${kind}:old-free-text`,
      actor: "b".repeat(64),
      occurredAt: new Date().toISOString(),
      payload: {
        rawCapture: "a".repeat(64),
        detectorVersion: "capture-scan-v1",
        record: "c".repeat(64),
        outcome: "clean",
        reason: "synthetic older-build reason",
      },
    });
    await runOn(
      location,
      Effect.gen(function* () {
        expect(yield* Log.append([event]).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InvalidEvent" },
        });
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES (${event.id},${event.kind},${event.idempotencyKey},${fingerprintOf(event)},${event.actor},${event.occurredAt},${event.occurredAt},${canonicalJson(event)})`;
        expect((yield* Log.history({}))[0]?.event).toEqual(event);
        expect((yield* Log.append([event]))[0]?.status).toBe("existing");
        expect((yield* Admin.rebuild).events).toBe(1);
      }),
    );
  });
