import { appendFileSync } from "node:fs";
import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Exit, Cause, Logger, References } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../../src/budget/cpu.ts";
import { localBudget } from "../../src/budget/local.ts";
import { blobChunks } from "../../src/search-index.ts";
import { overlapInput } from "./blob-overlap-input.ts";

const config = z
  .object({ root: z.string(), mode: z.enum(["background", "foreground"]) })
  .parse(JSON.parse(Bun.argv[2] ?? "{}"));
const { entries, contents, source, target } = overlapInput(config.root),
  location = storeLocationIn(`${config.root}/records`),
  layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(Store.layer(location, { create: false })),
    Layer.provideMerge(BunFileSystem.layer),
  );
const targetInput = z.object({ blob: z.literal(`git-blob:${target.oid}`) });
const program = Effect.gen(function* () {
  const store = yield* Computations.ComputationStore;
  let completedOthers = 0;
  return yield* blobChunks(
    config.root,
    config.mode === "background" ? entries : [target],
    source,
    contents,
  ).pipe(
    Effect.provideService(Computations.ComputationStore, {
      ...store,
      run: (spec, compute) => {
        const isChunk = spec.op === "harness.blob-chunks";
        const isTarget = isChunk && targetInput.safeParse(spec.inputs).success;
        const result = store.run(
          spec,
          isTarget
            ? Effect.andThen(
                Effect.sync(() => {
                  appendFileSync(
                    `${config.root}/executions`,
                    `${config.mode}\n`,
                  );
                  console.log(JSON.stringify({ event: "claimed" }));
                }),
                Effect.andThen(
                  config.mode === "background"
                    ? Effect.promise(async () => {
                        // X owns its claim, but has not entered cpuBatch yet.
                        const command = await new Response(
                          Bun.stdin.stream(),
                        ).text();
                        if (command !== "release\n")
                          throw new Error("Missing target release command");
                      })
                    : Effect.void,
                  compute,
                ),
              )
            : compute,
        );
        return config.mode === "background" && isChunk && !isTarget
          ? result.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  completedOthers++;
                  if (completedOthers === entries.length - 1)
                    console.log(
                      JSON.stringify({
                        event: "others-finished",
                        computed: completedOthers,
                      }),
                    );
                }),
              ),
            )
          : result;
      },
    }),
  );
});
const Role = z.object({
  type: z.literal("shared-work.role"),
  role: z.string(),
});
const logger = Logger.make(({ message }) => {
  for (const item of [message].flat()) {
    const parsed = Role.safeParse(item);
    if (
      config.mode === "foreground" &&
      parsed.success &&
      parsed.data.role === "waiter"
    )
      console.log(JSON.stringify({ event: "joined" }));
  }
});
const result = await Effect.runPromiseExit(
  program.pipe(
    Effect.provideService(CpuWork, {
      budget: localBudget(process.env.NEUVE_BUDGET_DIRECTORY),
      priority: {
        class: config.mode === "background" ? "preparation" : "interactive",
        position: config.mode === "background" ? "new" : "understand",
        stage: 0,
      },
      inherited: false,
    }),
    Effect.provide(layer),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
  { signal: AbortSignal.timeout(10000) },
);
if (Exit.isFailure(result)) {
  console.log(
    JSON.stringify({
      event: "failed",
      message: String(Cause.squash(result.cause)),
    }),
  );
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      event: "result",
      computed: result.value.computed,
      reused: result.value.reused,
      target: result.value.chunks.get(`${target.path}\0${target.oid}`),
    }),
  );
