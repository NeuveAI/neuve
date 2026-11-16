import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  SharedWork,
  type SharedWorkEvent,
} from "@neuve/records-core/shared-work";
import { Effect, Layer, Exit } from "effect";
import * as GraphClient from "@neuve/graph-client";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import {
  readOutlinesWithBudget,
  type OutlineBatch,
} from "../src/graph-outline.ts";
import { blobChunks } from "../src/search-index.ts";
import { slowOutlineEngine } from "./fixtures/slow-outline-engine.ts";

for (const survivor of [true, false])
  test(
    survivor
      ? "a surviving outline subscriber retains CPU accounting when the initiating blob caller cancels"
      : "cancelling every outline subscriber stops Graph and releases CPU accounting",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "outline-grant-lifetime-")),
        prior = process.env.NEUVE_BUDGET_DIRECTORY;
      process.env.NEUVE_BUDGET_DIRECTORY = join(root, "budget");
      const { source, bytes, entry } = slowOutlineEngine(root),
        budget = new Scheduler(1),
        ready =
          Promise.withResolvers<
            Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">
          >(),
        joined = Promise.withResolvers<void>(),
        graphDone = Promise.withResolvers<void>(),
        grantReleased = Promise.withResolvers<void>(),
        controller = new AbortController();
      const admit = budget.admit.bind(budget);
      budget.admit = async (...args) => {
        const grant = await admit(...args);
        return {
          ...grant,
          release: async () => {
            await grant.release();
            grantReleased.resolve();
          },
        };
      };
      const location = storeLocationIn(join(root, "records")),
        layer = Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(
            Layer.effectDiscard(Store.prepareForWrite).pipe(
              Layer.provideMerge(Store.layer(location, { create: true })),
            ),
          ),
          Layer.provideMerge(BunFileSystem.layer),
        );
      let symbolProcess:
        Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> | undefined;
      let outlineCalls = 0,
        graphCalls = 0,
        graphCancelled = false;
      const original = SharedWork.prototype.run,
        graphRead = GraphClient.readGraphSymbols;
      const sharedSpy = spyOn(SharedWork.prototype, "run").mockImplementation(
        new Proxy(original, {
          apply(target, receiver, args: Parameters<typeof original>) {
            const [options] = args;
            const second =
              options.scope.endsWith("shared-outlines-v4") &&
              ++outlineCalls === 2;
            return Reflect.apply(target, receiver, [
              {
                ...options,
                onEvent: (event: SharedWorkEvent) => {
                  options.onEvent?.(event);
                  if (
                    second &&
                    (event.role === "waiter" || event.role === "floor")
                  )
                    joined.resolve();
                },
              },
            ]);
          },
        }),
      );
      const graphSpy = spyOn(
        GraphClient,
        "readGraphSymbols",
      ).mockImplementation(async (...args: Parameters<typeof graphRead>) => {
        graphCalls++;
        try {
          let initialized = false;
          return await graphRead(args[0], {
            ...args[1],
            onCommand: (receipt) => {
              args[1]?.onCommand?.(receipt);
              if (receipt.stage === "symbols_init") initialized = true;
            },
            spawnProcess: async (launch) => {
              const child = launch();
              if (initialized) ready.resolve(child);
              return child;
            },
          });
        } finally {
          graphCancelled = args[0].signal?.aborted ?? false;
          graphDone.resolve();
        }
      });
      let owner: Promise<Exit.Exit<unknown, unknown>> | undefined,
        subscriber: Promise<OutlineBatch> | undefined;
      try {
        const state = await Effect.runPromise(
          Effect.gen(function* () {
            const context = yield* Effect.context<
              Computations.ComputationStore | Blobs.BlobStore
            >();
            const provide = <A, E, R>(work: Effect.Effect<A, E, R>) =>
              work.pipe(
                Effect.provideService(CpuWork, {
                  budget,
                  priority: {
                    class: "interactive",
                    position: "understand",
                    stage: 0,
                  },
                  inherited: false,
                }),
              );
            return yield* Effect.promise(async () => {
              owner = Effect.runPromiseExitWith(context)(
                provide(
                  blobChunks(
                    root,
                    [entry],
                    source,
                    new Map([[entry.oid, bytes]]),
                  ),
                ),
                { signal: controller.signal },
              );
              symbolProcess = await ready.promise;
              if (survivor) {
                subscriber = Effect.runPromiseWith(context)(
                  provide(
                    readOutlinesWithBudget(
                      [{ path: "a.ts", bytes }],
                      root,
                      source,
                    ),
                  ),
                );
                await joined.promise;
              }
              controller.abort();
              expect(Exit.isFailure(await owner)).toBe(true);
              const held = (await budget.observe()).held;
              if (survivor) {
                expect(symbolProcess.exitCode).toBeNull();
                if (!symbolProcess.stdin)
                  throw new Error("Missing Graph stdin");
                symbolProcess.stdin.write("go\n");
                await symbolProcess.stdin.end();
                expect((await subscriber)?.context("a.ts").kind).toBe(
                  "available",
                );
              }
              await graphDone.promise;
              await grantReleased.promise;
              return { held, cancelled: graphCancelled };
            });
          }).pipe(Effect.provide(layer)),
          { signal: AbortSignal.timeout(5000) },
        );
        if (survivor) expect(state.held).toBe(1);
        expect(state.cancelled).toBe(!survivor);
        expect(graphCalls).toBe(1);
        expect((await budget.observe()).held).toBe(0);
      } finally {
        controller.abort();
        symbolProcess?.kill();
        await Promise.allSettled([owner, subscriber]);
        if (graphCalls) await graphDone.promise;
        sharedSpy.mockRestore();
        graphSpy.mockRestore();
        if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
        else process.env.NEUVE_BUDGET_DIRECTORY = prior;
        rmSync(root, { recursive: true, force: true });
      }
    },
    7000,
  );
