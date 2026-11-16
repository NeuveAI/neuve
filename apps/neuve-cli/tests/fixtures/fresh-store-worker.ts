import "./startup-settings.ts";
import { spyOn } from "bun:test";
import * as Socket from "../../../../packages/records-core/src/worker-socket.ts";
import { createConnection } from "node:net";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";

import "../../../../packages/records-core/tests/fixture-worker-lifetime.ts";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const checkpoint = (event: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = createConnection(
      z.string().parse(process.env.FRESH_STORE_CONTROL),
    );
    const abort = () => socket.destroy();
    controller.signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => {
      controller.signal.removeEventListener("abort", abort);
      reject(new Error("test control closed"));
    });
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ event, pid: process.pid })}\n`),
    );
    socket.once("data", (data) => {
      socket.end();
      resolve(data.toString().trim());
    });
    socket.once("error", reject);
  });
const serve = Socket.serve;
spyOn(Socket, "serve").mockImplementation(
  (path, command, held, connection = Effect.void) =>
    serve(
      path,
      command,
      held,
      Effect.andThen(
        Effect.promise(() => checkpoint("connected")),
        connection,
      ),
    ),
);
const repository = z.string().parse(Bun.argv[Bun.argv.indexOf("--repo") + 1]);
const location = await Effect.runPromise(resolveStoreLocation(repository));
const withStartup = Worker.withStartup ?? ((_location, program) => program);
try {
  if ((await checkpoint("boot")) === "fail")
    throw new Error("forced startup failure before bind");
  const result = await Effect.runPromise(
    withStartup(
      location,
      Effect.gen(function* () {
        yield* Store.prepareForWrite;
        const sql = yield* SqlClient;
        yield* sql`CREATE TABLE IF NOT EXISTS startup_barrier (id INTEGER)`;
        const answer = yield* Effect.promise(() => checkpoint("opened"));
        if (answer === "fail")
          return yield* Effect.fail(new Error("forced startup failure"));
        return yield* Worker.run({
          location,
          handlers: {},
          idleTimeout: "60 seconds",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
    { signal: controller.signal },
  );
  process.stdout.write(`exit ${result.reason}\n`);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 2;
}

// Bun can retain a live server after Effect teardown; the real CLI exits explicitly too.
process.exit(process.exitCode ?? 0);
