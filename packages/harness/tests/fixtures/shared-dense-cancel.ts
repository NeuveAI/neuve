import { z } from "zod";
import { Effect, Layer, Exit, Cause } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { encodeChunks } from "../../../evaluation/src/retrieval-bench/dense.ts";
import { MODELS } from "../../../evaluation/src/retrieval-bench/models.ts";
import { EncoderFailed } from "../../../evaluation/src/retrieval-bench/encoder.ts";

const config = z
  .object({
    repository: z.string(),
    chunks: z.array(z.string()),
    mode: z.enum(["cancel", "failure", "defect"]).default("cancel"),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const emit = (event: string) => console.info(JSON.stringify({ event }));
process.on("unhandledRejection", () => emit("unhandled"));
const controller = new AbortController();
if (config.mode === "cancel")
  void (async () => {
    for await (const _ of Bun.stdin.stream()) {
      controller.abort();
      break;
    }
  })();
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const result = await Effect.runPromiseExit(
  encodeChunks(
    MODELS.E0,
    config.chunks.map((hash) => ({ hash, path: "0.ts", tokens: 1 })),
    {
      encode: () =>
        Effect.andThen(
          Effect.sync(() => emit("encode")),
          config.mode === "failure"
            ? Effect.fail(new EncoderFailed({ message: "encoder failure" }))
            : config.mode === "defect"
              ? Effect.die(new Error("encoder defect"))
              : Effect.never,
        ).pipe(
          Effect.onInterrupt(() => Effect.sync(() => emit("encoder-stopped"))),
        ),
    },
    1000,
    () => {},
  ).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  ),
  { signal: controller.signal },
);
if (Exit.isSuccess(result)) throw new Error("expected unsuccessful batch exit");
if (config.mode === "cancel" && !Cause.hasInterrupts(result.cause))
  throw new Error("expected interruption");
emit(config.mode);
emit("settled");
// Let Node/Bun report any pending unhandled rejection before the process exits naturally.
await new Promise((resolve) => setImmediate(resolve));
