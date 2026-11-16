/**
 * Measures one commit's relations index (NEU-148 WP11) against a scratch store under TMPDIR: the
 * engine's compact snapshot read, the index build and its storage, then the same computation again
 * against the same store (a stored read). The cold pass includes making the scratch store's private
 * Graph clone of the repository, which the engine reads. Prints one JSON line with both passes. The
 * engine is `NEUVE_GRAPH_OUTLINE_EXECUTABLE`, else the workspace's `apps/neuve-graph/entire-graph`.
 * Run it through the shared heavy-job queue on a real repository; it starts one engine process.
 *
 *   bun packages/harness/scripts/measure-relations.ts <repository> <commit>
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  relationsComputation,
  relationsRecords,
} from "../src/relations-index.ts";

const [repositoryArgument, commit] = process.argv.slice(2);
if (
  repositoryArgument === undefined ||
  commit === undefined ||
  !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
)
  throw new Error(
    "Usage: bun packages/harness/scripts/measure-relations.ts <repository> <full commit OID>",
  );
const repository = resolve(repositoryArgument);
const root = mkdtempSync(join(tmpdir(), "measure-relations-"));
const location = storeLocationIn(join(root, "records"));
const layer = Computations.layer.pipe(
  Layer.provideMerge(Blobs.layer(location)),
  Layer.provideMerge(
    Layer.effectDiscard(Store.prepareForWrite).pipe(
      Layer.provideMerge(Store.layer(location, { create: true })),
    ),
  ),
  Layer.provideMerge(BunFileSystem.layer),
);
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
try {
  const source = captureOutlineSource();
  // Two passes against one scratch store: the cold read computes, the second finds it stored.
  const passes = await Effect.runPromise(
    Effect.gen(function* () {
      const out = [];
      for (const pass of ["cold", "again"] as const) {
        const started = performance.now();
        // The scratch store's Graph folder: the engine reads its private clone of the repository.
        const { read } = yield* relationsComputation(
          repository,
          commit,
          source,
          join(root, "graph"),
        );
        out.push({
          pass,
          read,
          wallMs: Math.round(performance.now() - started),
        });
      }
      return out;
    }).pipe(Effect.provide(layer)),
  );
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const cold = passes[0];
  if (cold === undefined) throw new Error("no pass ran");
  const { read } = cold;
  const { index } = read;
  console.log(
    JSON.stringify({
      commit,
      passes: passes.map((pass) => ({
        pass: pass.pass,
        outcome: pass.read.status,
        wallMs: pass.wallMs,
      })),
      status: read.status,
      wallMs: cold.wallMs,
      recordsRead: relationsRecords(index),
      counts: index.coverage.counts,
      indexBytes: read.bytes,
      kept: {
        strings: index.strings.length,
        files: index.files.path.length,
        symbols: index.symbols.id.length,
        edges: index.edges.target.length,
        droppedTargets: index.dropped.target.length,
        droppedEdges: index.dropped.count.reduce(
          (sum, count) => sum + count,
          0,
        ),
      },
      peakRssBytes: peakRss,
    }),
  );
} finally {
  clearInterval(sampler);
  rmSync(root, { recursive: true, force: true });
}
