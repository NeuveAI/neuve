import { captureOutlineSource } from "../src/graph-outline.ts";
/** Reproduce the stopped review using only Git-derived facts in new temporary stores. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  commitPrepareHandler,
  enqueueRangePreparation,
} from "../src/commit-prepare.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { LEAD_CONCURRENCY, LeadConcurrency } from "../src/leads.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";

const implementation = resolve(import.meta.dir, "../../..");
const repository = process.env.NEUVE_MEASURE_REPOSITORY ?? implementation;
const revision = process.argv[2] ?? "de4a4832";
const destination = process.argv[3];
if (!destination)
  throw new Error(
    "Usage: bun packages/harness/scripts/measure-precompute.ts <revision> <output.json>",
  );
const git = (...args: string[]) => {
  const child = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
const headOid = git("rev-parse", `${revision}^{commit}`);
const baseOid = git("merge-base", "main", headOid);
const root = mkdtempSync(join(tmpdir(), "measure-precompute-"));
const settings = defaultManifestSettings(1_000_000);
const results: unknown[] = [];
const measure = async (concurrency: number, preparation: boolean) => {
  const location = storeLocationIn(
    join(root, `c${concurrency}-${preparation ? "prepared" : "cold"}`),
  );
  const records: RunLogRecord[] = [];
  const phases = () =>
    records
      .filter(
        (r) =>
          r.type === "span" &&
          typeof r.name === "string" &&
          r.name.startsWith("harness.precompute."),
      )
      .map((r) => ({
        name: r.name,
        ms: r.durationMs,
        status: r.status,
        attributes: r.attributes,
      }));
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        let preparationMs = 0;
        let jobs = 0;
        if (preparation) {
          const started = performance.now();
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
          while (true) {
            const next = yield* queue.take(["commit.prepare@2"]);
            if (Option.isNone(next)) break;
            yield* handler(next.value);
            yield* queue.complete(next.value.seq, next.value.attempts);
            jobs++;
          }
          preparationMs = performance.now() - started;
          records.length = 0;
        }
        const started = performance.now();
        const first = yield* rangeManifest(
          repository,
          { baseOid, headOid },
          settings,
          captureOutlineSource(),
        );
        const wallMs = performance.now() - started;
        const firstPhases = phases();
        records.length = 0;
        const secondStart = performance.now();
        const cycle = yield* rangeManifest(
          repository,
          { baseOid, headOid },
          settings,
          captureOutlineSource(),
        );
        return {
          concurrency,
          preparation,
          preparationMs,
          jobs,
          first: { wallMs, status: first.status, phases: firstPhases },
          nextCycle: {
            wallMs: performance.now() - secondStart,
            status: cycle.status,
            phases: phases(),
          },
          files: first.value.files,
          hunks: first.value.hunks.length,
          leads: first.leads.value.counts,
        };
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(LeadConcurrency, concurrency),
      Effect.withTracer(
        runLogTracer({
          path: "(memory)",
          write: (r) => records.push(r),
          read: () => records,
        }),
      ),
    ),
  );
  results.push(result);
  writeFileSync(
    destination,
    JSON.stringify(
      {
        headOid,
        baseOid,
        commits: Number(git("rev-list", "--count", `${baseOid}..${headOid}`)),
        root,
        defaultConcurrency: LEAD_CONCURRENCY,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({
      concurrency,
      preparation,
      preparationMs: result.preparationMs,
      ms: result.first.wallMs,
      nextCycleMs: result.nextCycle.wallMs,
      jobs: result.jobs,
    }) + "\n",
  );
};
const selected = process.argv[4];
if (selected !== undefined) {
  await measure(Number(selected), process.argv[5] === "prepared");
} else {
  const measurements = [];
  for (const [concurrency, preparation] of [
    ...[...new Set([1, 2, LEAD_CONCURRENCY])].map((n) => [n, false] as const),
    [LEAD_CONCURRENCY, true] as const,
  ]) {
    const part = join(root, `part-${concurrency}-${preparation}.json`);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        import.meta.path,
        revision,
        part,
        String(concurrency),
        preparation ? "prepared" : "cold",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await child.exited) !== 0)
      throw new Error("Measurement process failed");
    measurements.push(await Bun.file(part).json());
  }
  writeFileSync(
    destination,
    JSON.stringify(
      {
        headOid,
        baseOid,
        commits: Number(git("rev-list", "--count", `${baseOid}..${headOid}`)),
        defaultConcurrency: LEAD_CONCURRENCY,
        measurements,
      },
      null,
      2,
    ),
  );
}
