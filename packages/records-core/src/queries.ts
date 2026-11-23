import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  TEXT_CAPTURE_MEDIA_TYPE,
  type QueryRecorded,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { mintUlid } from "./ids.ts";
import { append } from "./log.ts";

export const record = (
  run: Pick<QueryRecorded, "actor" | "attribution" | "payload"> & {
    readonly question: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    const id = mintUlid();
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { blob } = yield* blobs.put({
          bytes: new TextEncoder().encode(run.question),
          mediaType: TEXT_CAPTURE_MEDIA_TYPE,
          retention: "raw-capture",
        });
        yield* append([
          {
            id,
            kind: "query.recorded@1",
            idempotencyKey: `query:${id}`,
            actor: run.actor,
            attribution: run.attribution,
            occurredAt,
            refs: [{ ref: `blob:${blob.hash}`, role: "question" }],
            payload: run.payload,
          } satisfies QueryRecorded,
        ]);
        return id;
      }),
    );
  });
