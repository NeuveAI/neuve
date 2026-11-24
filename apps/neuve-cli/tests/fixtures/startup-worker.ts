import "./startup-settings.ts";
// Process seams stop at real ownership boundaries without changing production startup.
import { spyOn } from "bun:test";
import { createConnection } from "node:net";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";
import * as Socket from "../../../../packages/records-core/src/worker-socket.ts";

import "../../../../packages/records-core/tests/fixture-worker-lifetime.ts";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const checkpoint = (event: string, always = false) =>
  Effect.promise(() => {
    if (!always && process.env.STARTUP_STEP !== event) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(
        z.string().parse(process.env.STARTUP_CONTROL),
      );
      const abort = () => socket.destroy();
      controller.signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => {
        controller.signal.removeEventListener("abort", abort);
        reject(new Error("control closed"));
      });
      socket.once("error", reject);
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ event, pid: process.pid })}\n`),
      );
      socket.once("data", () => {
        socket.end();
        resolve();
      });
    });
  });
const claim = Socket.claimWorkerLock;
spyOn(Socket, "claimWorkerLock").mockImplementation((path) =>
  Effect.tap(claim(path), (lock) =>
    lock ? checkpoint("locked") : Effect.void,
  ),
);
const serve = Socket.serve;
spyOn(Socket, "serve").mockImplementation(
  (path, command, held, connection = Effect.void, listenerScope) =>
    Effect.tap(
      serve(
        path,
        command,
        held,
        Effect.andThen(checkpoint("connection", true), connection),
        listenerScope,
      ),
      Effect.andThen(checkpoint("bound", true), checkpoint("reserved")),
    ),
);
const acknowledge = Socket.startupMayAcknowledge;
spyOn(Socket, "startupMayAcknowledge").mockImplementation(
  (location, path, claimed) =>
    Effect.andThen(
      claimed ? checkpoint("accepted") : Effect.void,
      acknowledge(location, path, claimed),
    ),
);
const repository = z.string().parse(Bun.argv[Bun.argv.indexOf("--repo") + 1]);
const location = await Effect.runPromise(resolveStoreLocation(repository));
let firstTransaction = true;
try {
  await Effect.runPromise(
    Effect.andThen(
      checkpoint("boot", true),
      Worker.withStartup(
        location,
        Effect.andThen(
          Store.prepareForWrite,
          Worker.run({
            location,
            handlers: {},
            idleTimeout: "60 seconds",
            afterRecovery: checkpoint("ready"),
          }).pipe(
            Effect.updateService(
              SqlClient,
              (sql) =>
                new Proxy(sql, {
                  get(target, property, receiver) {
                    if (property !== "withTransaction")
                      return Reflect.get(target, property, receiver);
                    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                      target.withTransaction(
                        Effect.suspend(() => {
                          if (!firstTransaction) return effect;
                          firstTransaction = false;
                          return Effect.andThen(
                            checkpoint("transaction"),
                            effect,
                          );
                        }),
                      );
                  },
                }),
            ),
          ),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
          Effect.provide(
            Layer.unwrap(
              Effect.as(
                checkpoint("opening"),
                Store.layer(location, { create: true }),
              ),
            ),
          ),
        ),
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
    { signal: controller.signal },
  );
  await Effect.runPromise(checkpoint("exited", true));
} catch (error) {
  if (!controller.signal.aborted) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 2;
  }
}

// Bun can retain a live server after Effect teardown; the real CLI exits explicitly too.
process.exit(process.exitCode ?? 0);
