import { appendFileSync } from "node:fs";
import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger, References, Option } from "effect";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { encodeChunks } from "../../../evaluation/src/retrieval-bench/dense.ts";
import {
  MODELS,
  modelIdentity,
} from "../../../evaluation/src/retrieval-bench/models.ts";
import { readStored } from "../../../evaluation/src/retrieval-bench/stored.ts";
const config = z
  .object({
    repository: z.string(),
    executions: z.string(),
    chunks: z.array(z.string()),
  })
  .parse(JSON.parse(process.env.NEUVE_DENSE_TEST ?? "{}"));
const emit = (event: string, fields: object = {}) =>
  console.info(JSON.stringify({ event, ...fields }));
const run = Promise.withResolvers<void>();
void (async () => {
  for await (const _ of Bun.stdin.stream()) {
    run.resolve();
    break;
  }
})();
const role = z.object({
  type: z.literal("shared-work.role"),
  role: z.string(),
});
const logger = Logger.make(({ message }) => {
  for (const item of [message].flat()) {
    const event = role.safeParse(item);
    if (event.success) emit("role", event.data);
  }
});
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const result = await Effect.runPromise(
  encodeChunks(
    MODELS.E0,
    config.chunks.map((hash, index) => ({
      hash,
      path: `${index}.ts`,
      tokens: 1,
    })),
    {
      encode: (texts) =>
        Effect.gen(function* () {
          appendFileSync(config.executions, `${JSON.stringify(texts)}\n`);
          emit("encode", { count: texts.length });
          yield* Effect.promise(() => run.promise);
          return {
            dim: MODELS.E0.dimensions,
            vectors: Float32Array.from(
              texts.flatMap((text) =>
                Array.from(
                  { length: MODELS.E0.dimensions },
                  (_, i) => ((text.charCodeAt(i % text.length) + i) % 127) / 8,
                ),
              ),
            ),
            tokens: texts.map(() => 1),
            millis: 1,
          };
        }),
    },
    1000,
    () => {},
  ).pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        const vectors = yield* Effect.forEach(config.chunks, (hash, index) =>
          Effect.map(
            readStored({
              op: "bench.encode-chunk",
              opVersion: 1,
              inputs: { chunk: `blob:${hash}`, path: `${index}.ts` },
              config: { model: modelIdentity(MODELS.E0) },
            }),
            (bytes) => Buffer.from(Option.getOrThrow(bytes)).toString("hex"),
          ),
        );
        return { ...result, vectors };
      }),
    ),
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
);
emit("result", {
  encoded: result.encoded,
  reused: result.reused,
  vectors: result.vectors,
});
process.exit(0);
