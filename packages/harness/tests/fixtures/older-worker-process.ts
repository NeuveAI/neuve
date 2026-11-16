import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as Socket from "effect/socket/Socket";
import { Store, Worker, resolveStoreLocation } from "@neuve/records-core";
import {
  migrations,
  MIGRATIONS_TABLE,
} from "../../../records-core/src/schema.ts";
import { z } from "zod";

// Copies 8891aaa2's worker.ts claim (652–711), queue.ts take, and worker-socket.ts serve.
// Store.layer is unchanged from that build: one scoped WAL connection, closed only on exit.
// Only the old claim SQL runs here, so migration 19 sees a writer unaware of its marker.
// No current Worker.run/serve, lifetime lock, recovery, scheduler, or publication is used.
const config = z
  .object({
    repository: z.string(),
    schema18: z.boolean().default(false),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
// That build bound `<store>/worker.sock`, inside the repository, as every build before the socket moved did.
const path = join(location.directory, "worker.sock");

// The base serve loop and BunSocketServer transport preserve its native accept backlog.
const serveConnection =
  (onCommand: (command: string) => string) => (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      let buffer = "";
      while (buffer.length <= 1_024) {
        buffer += (yield* pull).join("");
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          yield* writer.write(`${onCommand(buffer.slice(0, end).trim())}\n`);
          buffer = buffer.slice(end + 1);
          end = buffer.indexOf("\n");
        }
      }
    }).pipe(Effect.scoped, Effect.ignore);

await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (config.schema18) {
      // Migrations 1–18 and their metadata are unchanged from 8891aaa2.
      // Build that schema directly, without first creating or deleting migration 19's objects.
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord(
          Object.fromEntries(
            Object.entries(migrations).filter(
              ([name]) => Number(name.split("_")[0]) <= 18,
            ),
          ),
        ),
        table: MIGRATIONS_TABLE,
      });
      yield* sql`INSERT INTO jobs (kind, dedupe_key, enqueued_at)
        VALUES ('review.run@2', 'base-first', ${new Date().toISOString()})`;
    }
    const pid = process.pid;
    const startedAt = new Date().toISOString();
    let running: Worker.SlotJob | null = null;
    // The tests use the base's status and wake commands, not its stop/drop lifecycle.
    const onCommand = (command: string) => {
      if (command === "wake") return "ok";
      if (command !== "status") return "unknown command";
      return JSON.stringify({
        pid,
        startedAt,
        socket: path,
        slots: { interactive: running, background: null, capture: null },
        lastProgressAt: startedAt,
        lastProgress: "claimed",
      } satisfies Worker.WorkerStatusReply);
    };
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // These tests start the fixture on an unbound path. The base's liveness preflight
        // and release paths are irrelevant: every test ends this holder with SIGKILL.
        const server = yield* BunSocketServer.make({ path });
        yield* Effect.forkScoped(server.run(serveConnection(onCommand)));
        yield* sql`INSERT INTO worker_state ${sql.insert({
          id: 1,
          pid,
          socket: path,
          started_at: startedAt,
          last_progress_at: new Date().toISOString(),
          last_progress: "claimed",
        })} ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, socket = excluded.socket,
          started_at = excluded.started_at, last_progress_at = excluded.last_progress_at,
          last_progress = excluded.last_progress`;
      }),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [next] = yield* sql<{ jobSeq: number }>`SELECT job_seq FROM jobs
          WHERE state = 'waiting' AND kind = 'review.run@2' ORDER BY job_seq LIMIT 1`;
        if (!next)
          throw new Error("older worker fixture needs a waiting review job");
        yield* sql`UPDATE jobs SET state = 'active', attempts = attempts + 1,
          started_at = ${new Date().toISOString()}, finished_at = NULL WHERE job_seq = ${next.jobSeq}`;
        const [active] = yield* sql<{
          attempts: number;
          startedAt: string;
        }>`SELECT attempts, started_at
          FROM jobs WHERE job_seq = ${next.jobSeq}`;
        if (!active)
          throw new Error("older worker fixture lost its review job");
        running = {
          seq: next.jobSeq,
          kind: "review.run@2",
          attempt: active.attempts,
          startedAt: active.startedAt,
        };
      }),
    );
    console.info(JSON.stringify({ event: "run" }));
    yield* Effect.never;
  }).pipe(
    Effect.scoped,
    Effect.provide(Store.layer(location, { create: config.schema18 })),
    Effect.provide(BunFileSystem.layer),
  ),
);
