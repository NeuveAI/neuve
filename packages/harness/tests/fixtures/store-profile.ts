import { captureOutlineSource } from "../../src/graph-outline.ts";
// Run in a fresh process for each cold/warm measurement; writes only counts and timings.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Tracer } from "effect";
import { BlobRow, ComputationRow } from "@neuve/records-schema";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { BlobChunks, bm25Ranking, treeIndex } from "../../src/search-index.ts";
import { defaultManifestSettings, rangeManifest } from "../../src/manifest.ts";
import { cpuPool } from "../../src/budget/cpu.ts";

const [repository, revision, directory, label, baseRevision] =
  process.argv.slice(2);
if (!repository || !revision || !directory || !label)
  throw new Error("Expected repository revision store-directory label");
mkdirSync(directory, { recursive: true });
const location = storeLocationIn(directory);
let phase = "setup";
const statements = new Map<
  string,
  { count: number; rows: number; ms: number }
>();
const phases: Array<{ name: string; startMs: number; endMs: number }> = [];
const parsing = new Map<string, { count: number; ms: number }>();
const wrapped = new WeakSet<object>();
const query = Database.prototype.query;
Database.prototype.query = function <
  Row,
  Params extends SQLQueryBindings | SQLQueryBindings[],
>(text: string) {
  const invoke = query.bind(this);
  const statement = invoke<Row, Params>(text);
  if (!wrapped.has(statement)) {
    wrapped.add(statement);
    const all = statement.all;
    statement.all = function (...args) {
      const start = performance.now();
      const rows = all.apply(this, args);
      if (phase !== "setup") {
        const key = `${phase}\n${text.replace(/\s+/g, " ").trim()}`;
        const held = statements.get(key) ?? { count: 0, rows: 0, ms: 0 };
        held.count++;
        held.rows += rows.length;
        held.ms += performance.now() - start;
        statements.set(key, held);
      }
      return rows;
    };
  }
  return statement;
};

const timed =
  <A extends unknown[], B>(name: string, f: (...args: A) => B) =>
  (...args: A): B => {
    const start = performance.now();
    try {
      return f(...args);
    } finally {
      if (phase !== "setup") {
        const key = `${phase}.${name}`;
        const held = parsing.get(key) ?? { count: 0, ms: 0 };
        held.count++;
        held.ms += performance.now() - start;
        parsing.set(key, held);
      }
    }
  };
JSON.parse = timed("json", JSON.parse);
BlobRow.safeParse = timed("blob-schema", BlobRow.safeParse);
ComputationRow.safeParse = timed(
  "computation-schema",
  ComputationRow.safeParse,
);
BlobChunks.parse = timed("chunks-schema", BlobChunks.parse);
const origin = performance.now();
const tracer = Tracer.make({
  span(options) {
    const span = Tracer.nativeTracer.span(options);
    if (
      !/^(harness\.index\.(list|chunk|declarations|postings)|harness\.precompute\.hunks|harness\.leads\.(lookup|round))$/.test(
        options.name,
      )
    )
      return span;
    const previous = phase;
    phase = options.name;
    const startMs = performance.now() - origin;
    const end = span.end.bind(span);
    span.end = (at, exit) => {
      phases.push({
        name: options.name,
        startMs,
        endMs: performance.now() - origin,
      });
      phase = previous;
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
    phase = "index";
    const start = performance.now();
    const { index } = yield* treeIndex(
      repository,
      revision,
      captureOutlineSource(),
    );
    const indexMs = performance.now() - start;
    phase = "lead.search";
    const searchStart = performance.now();
    const ranked = bm25Ranking(index, "session storage transaction commit");
    const searchMs = performance.now() - searchStart;
    phase = "manifest";
    const manifestStart = performance.now();
    const manifest =
      baseRevision === undefined
        ? undefined
        : yield* rangeManifest(
            repository,
            { baseOid: baseRevision, headOid: revision },
            defaultManifestSettings(1_000_000),
            captureOutlineSource(),
          );
    const manifestMs = performance.now() - manifestStart;
    phase = "setup";
    return {
      indexMs,
      searchMs,
      files: index.files,
      chunks: index.chunks.length,
      computed: index.blobsComputed,
      reused: index.blobsReused,
      results: ranked.length,
      ...(manifest === undefined
        ? {}
        : {
            manifestMs,
            hunks: manifest.value.hunks.length,
            leadsCached: manifest.leads.value.counts.cached,
            leadsSearched: manifest.leads.value.counts.searched,
          }),
    };
  }).pipe(
    (work) =>
      process.env.NEUVE_STORE_PROFILE_POOL === "1"
        ? cpuPool("store-profile", 1, () => work)
        : work,
    Effect.withTracer(tracer),
    Effect.provide(layer),
  ),
);
const report = {
  label,
  repository,
  revision,
  originMs: origin,
  pooled: process.env.NEUVE_STORE_PROFILE_POOL === "1",
  ...result,
  phases,
  statements: Object.fromEntries(statements),
  parsing: Object.fromEntries(parsing),
};
await Bun.write(
  join(directory, `${label}.json`),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    label,
    ...result,
    statements: [...statements.values()].reduce((n, x) => n + x.count, 0),
    commits: [...statements.entries()]
      .filter(([key]) => /\nCOMMIT$/.test(key))
      .reduce((n, [, x]) => n + x.count, 0),
  }),
);
