import { SharedWork } from "@neuve/records-core/shared-work";
import { captureOutlineSource } from "../../src/graph-outline.ts";
import { openRunLog, runLogTracer } from "../../src/run-log.ts";
import { existsSync, writeFileSync } from "node:fs";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { prepareCode } from "../../src/commit-prepare.ts";
import { withCodeWork } from "../../src/code-work.ts";
import { indexOf } from "../../src/retrievers.ts";
const [mode, repository, storeRoot, marker, input] = Bun.argv.slice(2);
if (!repository || !storeRoot || !marker || !input)
  throw new Error("Missing fixture arguments");
const location = storeLocationIn(storeRoot);
if (mode === "prepare")
  writeFileSync(marker, JSON.stringify({ pid: process.pid }));
let builds = 0;
const tracer = runLogTracer(openRunLog(location, "preparation-fixture"));
const countedTracer = Tracer.make({
  span(options) {
    if (options.name === "harness.index.tree") builds++;
    return tracer.span(options);
  },
});
if (mode === "index" && process.env.NEUVE_TEST_INDEX_GATE === "1") {
  const original = SharedWork.prototype.run;
  SharedWork.prototype.run = new Proxy(original, {
    apply(target, receiver, args) {
      const options: Parameters<typeof original>[0] = args[0];
      if (!options.key.startsWith("tree-index@1"))
        return Reflect.apply(target, receiver, args);
      return Reflect.apply(target, receiver, [
        {
          ...options,
          onEvent: (
            event: import("@neuve/records-core/shared-work").SharedWorkEvent,
          ) => {
            options.onEvent?.(event);
            writeFileSync(`${marker}.${event.role}`, "ready");
          },
          run: async (signal: AbortSignal) => {
            writeFileSync(`${marker}.building`, "ready");
            while (!existsSync(`${marker}.continue`)) {
              signal.throwIfAborted();
              await Bun.sleep(10);
            }
            return options.run(signal);
          },
        },
      ]);
    },
  });
}
const work = Effect.gen(function* () {
  if (mode === "prepare") {
    yield* prepareCode(repository, location, JSON.parse(input));
    return;
  }
  const result = yield* withCodeWork(
    location,
    false,
    Effect.gen(function* () {
      writeFileSync(marker, JSON.stringify({ pid: process.pid }));
      while (!existsSync(`${marker}.go`)) yield* Effect.sleep(10);
      return yield* indexOf(repository, input, captureOutlineSource());
    }),
  );
  process.stdout.write(
    JSON.stringify({
      cached: result.cached,
      tree: result.index.tree,
      builds,
      fallback: result.index.chunks[0]?.fallback,
    }) + "\n",
  );
});
await Effect.runPromise(
  Effect.andThen(Store.prepareForWrite, work).pipe(
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: true })),
    Effect.provide(BunFileSystem.layer),
    Effect.provideService(Tracer.Tracer, countedTracer),
  ),
);
