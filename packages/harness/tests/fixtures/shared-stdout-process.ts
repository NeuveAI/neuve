import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
const config = z
  .object({ repository: z.string() })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const result = await Effect.runPromise(
  Computations.ComputationStore.use((store) =>
    store.run(
      { op: "test.stdout", opVersion: 1, inputs: {} },
      Effect.succeed({
        bytes: new TextEncoder().encode("receipt"),
        mediaType: "text/plain",
      }),
    ),
  ).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  ),
);
process.stdout.write(
  JSON.stringify({
    status: result.status,
    value: new TextDecoder().decode(result.output),
  }) + "\n",
);
