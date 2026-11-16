import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger, References } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";
const config = z
  .object({
    repository: z.string(),
    failed: z.boolean().default(false),
    exhausted: z.boolean().default(false),
    held: z.boolean().default(false),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const emit = (event: string, fields: object = {}) =>
  console.info(JSON.stringify({ event, ...fields }));
const finish = Promise.withResolvers<void>();
void (async () => {
  for await (const _ of Bun.stdin.stream()) {
    finish.resolve();
    break;
  }
})();
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    Worker.run({
      location,
      idleTimeout: "30 seconds",
      pollInterval: "30 seconds",
      handlers: {
        "review.run@2": () =>
          Effect.gen(function* () {
            emit("run");
            yield* Effect.promise(() => finish.promise);
            if (config.failed)
              return yield* Effect.fail({
                _tag: "FixtureFailed",
                message: "job fixture cause",
                retryable: config.exhausted,
              });
          }),
      },
      afterRecovery: Effect.sync(() => emit("ready")),
      ...(config.held ? { admit: () => Effect.succeed(false) } : {}),
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(
      Logger.layer([
        Logger.make(({ message }) => {
          if (
            [message]
              .flat()
              .some(
                (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  "type" in item &&
                  item.type === "job.notices-drained",
              )
          ) {
            emit("drained");
            if (
              [message]
                .flat()
                .some(
                  (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    "delivered" in item &&
                    item.delivered === 0,
                )
            )
              emit("empty-drain");
            if (
              [message]
                .flat()
                .some(
                  (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    "delivered" in item &&
                    typeof item.delivered === "number" &&
                    item.delivered > 0,
                )
            )
              emit("delivered");
          }
          if (
            [message]
              .flat()
              .some(
                (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  "type" in item &&
                  item.type === "job.subscription",
              )
          )
            emit("subscribed");
        }),
      ]),
    ),
  ),
);
emit("exit");
process.exit(0);
