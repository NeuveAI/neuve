import { Database } from "bun:sqlite";
import { z } from "zod";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { JobQueue, Store, resolveStoreLocation } from "@neuve/records-core";

const config = z
  .object({
    repository: z.string(),
    seq: z.number(),
    mode: z.enum(["older-sql", "commit-kill"]),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const committed = () => console.info(JSON.stringify({ event: "committed" }));
if (config.mode === "older-sql") {
  const db = new Database(location.database);
  db.run("PRAGMA busy_timeout = 5000");
  // The base queue's drop statement, with no current-build publication call.
  db.transaction(() =>
    db.run(
      "UPDATE jobs SET state = 'failed', run_at = NULL, finished_at = ?, last_error = ? WHERE job_seq = ?",
      [
        new Date().toISOString(),
        JSON.stringify({
          tag: "Dropped",
          message: "dropped while waiting",
          attempt: 0,
          at: new Date().toISOString(),
        }),
        config.seq,
      ],
    ),
  )();
  db.close();
  committed();
} else {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* Effect.scoped(
        Effect.map(sql.reserve, (connection) => {
          const control = connection.executeUnprepared.bind(connection);
          Object.defineProperty(connection, "executeUnprepared", {
            value: (...args: Parameters<typeof control>) =>
              args[0] === "COMMIT"
                ? control(...args).pipe(
                    Effect.andThen(Effect.sync(committed)),
                    Effect.andThen(Effect.never),
                  )
                : control(...args),
          });
        }),
      );
      yield* JobQueue.JobQueue.use((queue) => queue.drop(config.seq));
    }).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Store.layer(location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
}
process.exit(0);
