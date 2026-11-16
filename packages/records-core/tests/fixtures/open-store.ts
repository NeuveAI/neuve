// Opens one store for writing in its own process, for the concurrent-openers test. Records' one
// line goes to stderr, as it does for a CLI command.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { Store, storeLocationIn } from "../../src/index.ts";

const [commonDirectory] = Bun.argv.slice(2);
if (commonDirectory === undefined)
  throw new Error("usage: open-store.ts <common directory>");
const location = storeLocationIn(commonDirectory);
await Effect.runPromise(
  Store.prepareForWrite.pipe(
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  ),
);
process.stdout.write("opened\n");
