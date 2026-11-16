/** Measures the whole code stage, including a new cycle's scope snapshot, without models. */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  commitPrepareHandler,
  enqueueRangePreparation,
} from "../src/commit-prepare.ts";
import { defaultConfig } from "../src/config.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { precomputeStage } from "../src/pipeline.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { withCodeWork } from "../src/code-work.ts";

const implementation = resolve(import.meta.dir, "../../..");
const repository = process.env.NEUVE_MEASURE_REPOSITORY ?? implementation;
const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: bun packages/harness/scripts/measure-precompute-stage.ts <output.json> [prepared|concurrent]",
  );
const git = (...args: string[]) => {
  const child = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
const headOid = git("rev-parse", "de4a4832^{commit}");
const baseOid = git("merge-base", "main", headOid);
const root = mkdtempSync(join(tmpdir(), "precompute-stage-measure-"));
const location = storeLocationIn(root);
const scope = await Effect.runPromise(Scope.make());
const records = await Effect.runPromise(
  Layer.buildWithScope(
    Layer.mergeAll(
      JobQueue.layer,
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ).pipe(
      Layer.provideMerge(Store.layer(location, { create: true })),
      Layer.provideMerge(BunFileSystem.layer),
    ),
    scope,
  ),
);
const log: RunLogRecord[] = [];
const sink = {
  path: "(memory)",
  write: (r: RunLogRecord) => {
    log.push(r);
  },
  read: () => log,
};
const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(records), Effect.withTracer(runLogTracer(sink)));
try {
  await Effect.runPromise(traced(Store.prepareForWrite));
  const integrations = { status: "absent", path: "(none)" } as const;
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), scope),
    ),
    McpClients,
  );
  let preparationMs = 0;
  let jobs = 0;
  const prepare = async () => {
    const started = performance.now();
    await Effect.runPromise(
      traced(
        Effect.gen(function* () {
          yield* enqueueRangePreparation(repository, { baseOid, headOid });
          const queue = yield* JobQueue.JobQueue;
          const handler = commitPrepareHandler({
            repository,
            location,
            command: [
              process.execPath,
              "--no-env-file",
              join(implementation, "apps/neuve-cli/src/cli.ts"),
            ],
          });
          for (;;) {
            const next = yield* queue.take(["commit.prepare@2"]);
            if (Option.isNone(next)) break;
            yield* handler(next.value);
            yield* queue.complete(next.value.seq, next.value.attempts);
            jobs++;
          }
        }),
      ),
    );
    preparationMs = performance.now() - started;
  };
  if (process.argv[3] === "prepared") await prepare();
  let concurrent:
    { childNice: number; childPid: number; reviewMs: number } | undefined;
  let preparation: Promise<void> | undefined;
  const attempts = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    log.length = 0;
    const ctx = {
      location,
      repository,
      runId: mintUlid(),
      runKey: "0".repeat(64),
      cycleId: mintUlid(),
      range: { baseRef: "main", baseOid, headOid },
      config: defaultConfig(),
      log: sink,
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    };
    const started = performance.now();
    const review = precomputeStage(ctx, { integrations, clients });
    const stage = await Effect.runPromise(
      traced(
        cycle === 0 && process.argv[3] === "concurrent"
          ? withCodeWork(
              location,
              false,
              Effect.gen(function* () {
                preparation = prepare();
                // Wait for the real CPU child to register, while this review holds precedence.
                const actors = join(location.directory, "code-work", "actors");
                let childPid: number | undefined;
                for (let i = 0; i < 6000; i++) {
                  childPid = readdirSync(actors)
                    .map((name) => Number(name.split("-")[0]))
                    .find((pid) => pid !== process.pid);
                  if (childPid !== undefined) break;
                  yield* Effect.sleep(10);
                }
                if (childPid === undefined)
                  throw new Error("Preparation child never registered");
                const childNice = getPriority(childPid);
                const start = performance.now();
                const value = yield* review;
                concurrent = {
                  childPid,
                  childNice,
                  reviewMs: performance.now() - start,
                };
                return value;
              }),
            )
          : review,
      ),
    );
    attempts.push({
      cycle,
      wallMs: performance.now() - started,
      stage,
      phases: log
        .filter(
          (r) =>
            r.type === "span" &&
            typeof r.name === "string" &&
            r.name.startsWith("harness.precompute."),
        )
        .map((r) => ({ name: r.name, ms: r.durationMs })),
      manifest: log.find((r) => r.type === "precompute.manifest"),
    });
    // Release the review's priority marker before joining paused preparation.
    if (preparation) {
      await preparation;
      preparation = undefined;
    }
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        headOid,
        baseOid,
        commits: Number(git("rev-list", "--count", `${baseOid}..${headOid}`)),
        root,
        preparationMs,
        jobs,
        concurrent,
        attempts,
      },
      null,
      2,
    ),
  );
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}
