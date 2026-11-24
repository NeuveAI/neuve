// A source checkout can disappear while its worker still has jobs to hand off.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer, Logger, Option } from "effect";
import { Blobs, Computations, JobQueue, Worker } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

test("the worker stops before claiming its next job when its source checkout disappears", async () => {
  const location = freshLocation();
  const checkout = join(dirname(location.directory), "source");
  const config = join(checkout, "bunfig.toml");
  mkdirSync(checkout);
  writeFileSync(config, "");
  const logs: string[] = [];
  const { exit, first, waiting } = await runOn(
    location,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const first = yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "first",
      });
      const next = yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "next",
      });
      const exit = yield* Worker.run({
        location,
        build: { kind: "source", path: config },
        idleTimeout: "100 millis",
        handlers: {
          "worker.probe": () =>
            Effect.sync(() =>
              rmSync(checkout, { recursive: true, force: true }),
            ),
        },
      });
      return {
        exit,
        first: Option.getOrThrow(yield* queue.inspect(first.job.seq)),
        waiting: Option.getOrThrow(yield* queue.inspect(next.job.seq)),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          Logger.layer([
            Logger.make(({ message }) => logs.push(String(message))),
          ]),
        ),
      ),
    ),
  );
  expect(first).toMatchObject({ state: "completed", attempts: 1 });
  expect(waiting).toMatchObject({
    state: "waiting",
    attempts: 0,
    lastError: null,
  });
  expect(exit.reason).toBe("build-unavailable");
  expect(logs).toContain(
    `exiting: worker source checkout was removed (${config})`,
  );
});
