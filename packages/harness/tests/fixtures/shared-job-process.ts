import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger } from "effect";
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
  Worker.run({
    location,
    idleTimeout: "2 seconds",
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
              retryable: false,
            });
        }),
    },
    afterRecovery: Effect.sync(() => emit("ready")),
    ...(config.held ? { admit: () => Effect.succeed(false) } : {}),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
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
