import { writeFileSync, fstatSync } from "node:fs";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { prepareCode } from "../../src/commit-prepare.ts";
const [repository, storeRoot, output, input] = Bun.argv.slice(2);
if (!repository || !storeRoot || !output || !input)
  throw new Error("Missing preparation fixture arguments");
const location = storeLocationIn(storeRoot);
await Effect.runPromise(
  Effect.andThen(
    Store.prepareForWrite,
    prepareCode(repository, location, JSON.parse(input)),
  ).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
  ),
);
writeFileSync(
  output,
  JSON.stringify({
    permits: Number(process.env.NEUVE_CPU_GRANT_PERMITS),
    inherited:
      process.env.NEUVE_CPU_GRANT_PERMITS !== undefined &&
      fstatSync(3).isSocket(),
    gomax: process.env.GOMAXPROCS,
  }),
);
