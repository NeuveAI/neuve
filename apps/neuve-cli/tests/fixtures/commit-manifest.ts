import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { prepareCommitManifest } from "../../../../packages/harness/src/commit-prepare.ts";
import { captureOutlineSource } from "../../../../packages/harness/src/graph-outline.ts";
import { PreparationPayload } from "@neuve/records-schema";
const [repository, directory, text] = Bun.argv.slice(2);
if (!repository || !directory || !text)
  throw new Error("Missing fixture inputs");
const input = PreparationPayload.parse(JSON.parse(text));
if (input.kind !== "commit") throw new Error("Expected a commit");
const location = storeLocationIn(directory);
const result = await Effect.runPromise(
  prepareCommitManifest(repository, input.commit, captureOutlineSource()).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  ),
);
const manifest = Option.getOrThrow(result);
process.stdout.write(
  `manifest-result ${JSON.stringify({ key: manifest.key, status: manifest.status })}\n`,
);
