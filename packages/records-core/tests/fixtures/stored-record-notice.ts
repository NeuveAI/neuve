import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Log, canonicalJson } from "../../src/index.ts";
import { fingerprintOf } from "../../src/codec.ts";
import {
  commitEvent,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "../support.ts";

try {
  const location = freshLocation();
  await runOn(
    location,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      let number = 0;
      for (const extra of [
        { newer: "private-value" },
        { another: "private-value" },
      ]) {
        const event = { ...commitEvent(String(++number).repeat(40)), ...extra };
        const stored = canonicalJson(event);
        yield* sql`INSERT INTO events ${sql.insert({
          id: event.id,
          kind: event.kind,
          idempotency_key: event.idempotencyKey,
          fingerprint: fingerprintOf(event),
          actor_id: event.actor,
          occurred_at: event.occurredAt,
          recorded_at: event.occurredAt,
          envelope: stored,
        })}`;
        const decoded = yield* Log.get(event.id);
        if (
          Option.isNone(decoded) ||
          decoded.value.event.kind !== "commit.recorded@1"
        )
          throw new Error("The stored event was not read");
        const [row] = yield* sql<{
          envelope: string;
        }>`SELECT envelope FROM events WHERE id = ${event.id}`;
        if (row?.envelope !== stored)
          throw new Error("The newer record was changed");
      }
    }),
  );
} finally {
  removeTemporaryDirectories();
}
