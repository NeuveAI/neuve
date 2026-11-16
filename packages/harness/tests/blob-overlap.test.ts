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
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler, type Priority } from "../src/budget/scheduler.ts";
import { blobChunks } from "../src/search-index.ts";
import { overlapInput } from "./fixtures/blob-overlap-input.ts";

const layerFor = (root: string) => {
  const location = storeLocationIn(join(root, "records"));
  return Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
};
const preparation: Priority = {
    class: "preparation",
    position: "new",
    stage: 0,
  },
  interactive: Priority = {
    class: "interactive",
    position: "understand",
    stage: 0,
  };
const admitted = <A, E, R>(
  budget: Scheduler,
  priority: Priority,
  work: Effect.Effect<A, E, R>,
) =>
  work.pipe(
    Effect.provideService(CpuWork, { budget, priority, inherited: false }),
  );

// Pause owned chunk work before admission, then observe the actual subscriber while it waits.
test("a foreground blob request joins an overlapping background computation without CPU", async () => {
  const root = mkdtempSync(join(tmpdir(), "blob-overlap-")),
    { entries, contents, source, target } = overlapInput(root),
    budget = new Scheduler(1),
    admit = budget.admit.bind(budget),
    targetClaimed = Promise.withResolvers<void>(),
    backgroundQueued = Promise.withResolvers<void>(),
    joined = Promise.withResolvers<void>(),
    allowBackground = Promise.withResolvers<void>(),
    targetInput = z.object({ blob: z.literal(`git-blob:${target.oid}`) });
  let backgroundRequests = 0,
    targetStarted = false,
    targetKey = "";
  const original = SharedWork.prototype.run;
  const spy = spyOn(SharedWork.prototype, "run").mockImplementation(
    new Proxy(original, {
      apply(run, receiver, args: Parameters<typeof original>) {
        const [options] = args;
        return Reflect.apply(run, receiver, [
          {
            ...options,
            onEvent: (event: SharedWorkEvent) => {
              options.onEvent?.(event);
              if (
                targetStarted &&
                options.key === targetKey &&
                (event.role === "waiter" || event.role === "floor")
              )
                joined.resolve();
            },
          },
        ]);
      },
    }),
  );
  try {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const store = yield* Computations.ComputationStore;
        budget.admit = async (request, signal) => {
          if (
            request.priority.class === "preparation" &&
            ++backgroundRequests === 2
          ) {
            await targetClaimed.promise;
            backgroundQueued.resolve();
            await allowBackground.promise;
          }
          return admit(request, signal);
        };
        const results = yield* Effect.all(
          {
            callers: Effect.all(
              [
                admitted(
                  budget,
                  preparation,
                  blobChunks(root, entries, source, contents),
                ),
                admitted(
                  budget,
                  interactive,
                  Effect.andThen(
                    Effect.promise(() => backgroundQueued.promise),
                    blobChunks(root, [target], source, contents),
                  ),
                ),
              ],
              { concurrency: 2 },
            ),
            heldWhileWaiting: Effect.promise(async () => {
              await joined.promise;
              const held = (await budget.observe()).held;
              allowBackground.resolve();
              return held;
            }),
          },
          { concurrency: 2 },
        ).pipe(
          Effect.provideService(Computations.ComputationStore, {
            ...store,
            run: (spec, compute) => {
              if (
                spec.op !== "harness.blob-chunks" ||
                !targetInput.safeParse(spec.inputs).success
              )
                return store.run(spec, compute);
              targetKey = Computations.computationKey(spec).key;
              return store.run(
                spec,
                Effect.andThen(
                  Effect.sync(() => {
                    targetStarted = true;
                    targetClaimed.resolve();
                  }),
                  compute,
                ),
              );
            },
          }),
          Effect.ensuring(Effect.sync(() => allowBackground.resolve())),
        );
        // One attempt per key: the target's chunks, and its structure from the same pass.
        const attempts = yield* sql<{
          operation: string;
          outcome: string;
          n: number;
        }>`SELECT json_extract(c.material, '$.op') AS operation, a.outcome, count(*) AS n FROM computation_attempts a JOIN computations c ON c.key = a.key WHERE json_extract(c.material, '$.inputs.blob') = ${`git-blob:${target.oid}`} GROUP BY operation, a.outcome ORDER BY operation`;
        return { ...results, attempts };
      }).pipe(Effect.provide(layerFor(root))),
      { signal: AbortSignal.timeout(3000) },
    );
    expect(observed.heldWhileWaiting).toBe(0);
    expect(observed.callers.map((r) => [r.computed, r.reused])).toEqual([
      [33, 0],
      [0, 1],
    ]);
    expect(
      observed.callers[1].chunks.get(`${target.path}\0${target.oid}`),
    ).toEqual(observed.callers[0].chunks.get(`${target.path}\0${target.oid}`));
    expect(observed.attempts).toEqual([
      { operation: "harness.blob-chunks", outcome: "succeeded", n: 1 },
      { operation: "harness.blob-structure", outcome: "succeeded", n: 1 },
    ]);
    expect((await budget.observe()).held).toBe(0);
  } finally {
    allowBackground.resolve();
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
