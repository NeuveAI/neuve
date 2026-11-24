// A wake acknowledgment can strand the queued job if the old worker exits after answering.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Starter,
  Worker,
} from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";
import { workerSuite } from "./worker-suite.ts";

const workers = workerSuite();
afterAll(removeTemporaryDirectories);

test("one wake replaces a worker whose build disappeared and completes the queued job", async () => {
  const owner = await workers.start();
  const location = freshLocation();
  const repository = dirname(location.directory);
  const checkout = join(repository, "source");
  const config = join(checkout, "bunfig.toml");
  mkdirSync(checkout);
  writeFileSync(config, "");
  const { exit, completed } = await runOn(
    location,
    Effect.gen(function* () {
      const idle = yield* Deferred.make<void>();
      const old = yield* Effect.forkScoped(
        Worker.withStartup(
          location,
          Worker.run({
            location,
            build: { kind: "source", path: config },
            handlers: { "worker.probe": () => Effect.void },
            eachTurn: Effect.andThen(
              Deferred.succeed(idle, undefined),
              Effect.never,
            ),
          }),
        ),
      );
      yield* Deferred.await(idle);
      rmSync(checkout, { recursive: true });
      const queue = yield* JobQueue.JobQueue;
      const { job } = yield* queue.enqueue({
        kind: "worker.probe",
        dedupeKey: "handoff",
      });
      const started = yield* Starter.ensureWorkerAt(location, {
        repository,
        command: [
          "env",
          `NEUVE_FIXTURE_OWNER=${owner.env.NEUVE_FIXTURE_OWNER}`,
          process.execPath,
          join(import.meta.dir, "fixtures/run-worker.ts"),
          repository,
          "1000",
        ],
        waitForReady: true,
      });
      expect(started.status).toBe("spawned");
      const inspect = queue
        .inspect(job.seq)
        .pipe(Effect.map(Option.getOrThrow));
      const completed = yield* Effect.acquireUseRelease(
        Effect.tryPromise((signal) =>
          Worker.subscribeJob(location, job.seq, signal),
        ),
        (subscription) =>
          Effect.gen(function* () {
            const current = yield* inspect;
            if (current.state === "completed") return current;
            yield* Effect.tryPromise(() => subscription.next());
            return yield* inspect;
          }),
        (subscription) => Effect.sync(() => subscription.close()),
      );
      return { exit: yield* Fiber.join(old), completed };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
    ),
  );
  expect(exit.reason).toBe("build-unavailable");
  expect(completed).toMatchObject({ state: "completed", attempts: 1 });
}, 15_000);
