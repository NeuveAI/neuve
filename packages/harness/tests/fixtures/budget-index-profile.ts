import { captureOutlineSource } from "../../src/graph-outline.ts";
// Runs only product index preparation. Reports counts and timings, never source content.
import { mkdirSync } from "node:fs";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { Effect, Layer, Tracer } from "effect";
import { CpuWork, cpuPool } from "../../src/budget/cpu.ts";
import {
  workerBudget,
  clientBudget,
  closeWorkerBudget,
} from "../../src/budget/local.ts";
import { treeIndex } from "../../src/search-index.ts";

const [repository, revision, directory, mode = "direct"] =
  process.argv.slice(2);
if (!repository || !revision || !directory)
  throw new Error(
    "Expected repository revision store-directory [direct|outer|client]",
  );
mkdirSync(directory, { recursive: true });
const location = storeLocationIn(directory);
const budget = mode === "client" ? await clientBudget() : await workerBudget();
let admissions = 0;
let floorAdmissions = 0;
let admissionMs = 0;
let releaseMs = 0;
const admit = budget.admit.bind(budget);
budget.admit = async (...args) => {
  const start = performance.now();
  const grant = await admit(...args);
  admissions++;
  floorAdmissions += grant.floor ? 1 : 0;
  admissionMs += performance.now() - start;
  const release = grant.release.bind(grant);
  return {
    ...grant,
    async release(observation) {
      const at = performance.now();
      await release(observation);
      releaseMs += performance.now() - at;
    },
  };
};
const phases: Array<{ name: string; ms: number }> = [];
const tracer = Tracer.make({
  span(options) {
    const span = Tracer.nativeTracer.span(options);
    if (
      !/^harness\.index\.(list|chunk|declarations|postings)$/.test(options.name)
    )
      return span;
    const start = performance.now();
    const end = span.end.bind(span);
    span.end = (at, exit) => {
      phases.push({ name: options.name, ms: performance.now() - start });
      end(at, exit);
    };
    return span;
  },
});
const layer = Computations.layer.pipe(
  Layer.provideMerge(Blobs.layer(location)),
  Layer.provideMerge(
    Layer.effectDiscard(Store.prepareForWrite).pipe(
      Layer.provideMerge(Store.layer(location, { create: true })),
    ),
  ),
  Layer.provideMerge(BunFileSystem.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const start = performance.now();
    const { index } = yield* treeIndex(
      repository,
      revision,
      captureOutlineSource(),
    );
    return {
      preparationMs: performance.now() - start,
      files: index.files,
      chunks: index.chunks.length,
      computed: index.blobsComputed,
      reused: index.blobsReused,
    };
  }).pipe(
    (work) =>
      mode === "outer" ? cpuPool("budget-profile", 1, () => work) : work,
    Effect.provideService(CpuWork, {
      budget,
      priority: { class: "interactive", position: "understand", stage: 0 },
      inherited: false,
    }),
    Effect.withTracer(tracer),
    Effect.provide(layer),
  ),
);
console.log(
  JSON.stringify({
    mode,
    ...result,
    admissions,
    floorAdmissions,
    admissionMs,
    releaseMs,
    phases,
  }),
);
await closeWorkerBudget();
