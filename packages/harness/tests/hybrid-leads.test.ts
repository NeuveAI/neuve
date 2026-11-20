import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: hybrid leads (10.117-10.119) are computed at commit time and only read by a review, so
// every way they can go wrong is silent at the review: a lead from an unready tree, a rerank that
// ignores the reranker's order, provenance that names the wrong source (3.4), a lead that is not a
// chunk the packet can cite, a review that waits on or runs a model, or a hunk without hybrid leads
// that gets keyword leads under the hybrid name. This prepares commits of a small repository with
// fake model workers (the real ones need weights this machine does not have yet) and checks what
// the commit job stores and what the review reads.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option, Tracer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  pendingHybrid,
  prepareHybrid,
  prepareNextBase,
  type HybridEnvironment,
} from "../src/commit-hybrid.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { E0_DIMENSIONS, type E0Runtime } from "../src/e0.ts";
import { treeOf } from "../src/git-objects.ts";
import type { GraphRuntime } from "../src/graph-search.ts";
import {
  encodeChunks,
  localChunkSpec,
  localTreeVectors,
  type ChunkEncoder,
} from "../src/hybrid-vectors.ts";
import type { GraphPool, PairReranker } from "../src/hybrid.ts";
import { benchChunkSpec } from "../src/e0.ts";
import {
  defaultManifestSettings,
  leadsByHunk,
  rangeManifest,
} from "../src/manifest.ts";
import type { GraphConfig, SearchResult } from "../src/retriever.ts";
import { indexOf } from "../src/retrievers.ts";
import { hybridConfigFor } from "../src/search-config.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-hybrid-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const repository = join(directory, "repo");
const run = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (message: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(repository, path), text);
    run("add", path);
  }
  run(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return run("rev-parse", "HEAD");
};
const values = (changes: Record<number, string>) =>
  Array.from(
    { length: 60 },
    (_, index) =>
      changes[index + 1] ??
      `export const value${index + 1} = computeValue(${index + 1}, "label ${index + 1}");`,
  ).join("\n") + "\n";

/** A deterministic unit vector for a text: the fake model. */
const vectorOf = (text: string) => {
  const vector = new Float32Array(E0_DIMENSIONS);
  let seed = createHash("sha256").update(text).digest();
  for (let at = 0; at < E0_DIMENSIONS; at++) {
    if (at % 32 === 0)
      seed = createHash("sha256").update(seed).update(String(at)).digest();
    vector[at] = (seed[at % 32]! - 127.5) / 127.5;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
};

const calls = { encoded: 0, reranked: 0 };
/** The commits whose Graph base a job asked to prepare for the next commit. */
const prepared: Array<string> = [];
const encoder: ChunkEncoder = {
  device: "cpu",
  workerSha256: "e".repeat(64),
  encode: (items) =>
    Effect.sync(() =>
      items.map((item) => {
        calls.encoded++;
        return item.text.includes("TOO LONG")
          ? { kind: "refused" as const, reason: "token-limit-exceeded" }
          : { kind: "vector" as const, vector: vectorOf(item.text) };
      }),
    ),
};
/** The fake reranker prefers documents about computeValue's fifth label, then shorter ones. */
const reranker: PairReranker = {
  device: "cpu",
  workerSha256: "f".repeat(64),
  score: (_query, documents) =>
    Effect.sync(() => {
      calls.reranked += documents.length;
      return {
        scores: documents.map(
          (document) =>
            (document.includes("renamed five") ? 0.5 : 0) +
            1 / (10 + document.length / 100),
        ),
        truncated: documents.map(() => false),
      };
    }),
};
const graphConfig: GraphConfig = {
  id: "graph",
  engine: {
    sha256: "b".repeat(64),
    provider: "fake",
    version: "0",
    identityRevision: "r",
  },
  profile: "full",
  topK: 50,
};
const config = hybridConfigFor(
  {
    prepare: true,
    device: "cpu",
    e0: {} as E0Runtime,
    graph: {} as GraphRuntime,
    models: 2,
    limits: { minFreeDiskBytes: 1, maxSwapUsedBytes: Number.MAX_SAFE_INTEGER },
    reranker: { snapshot: "/r", worker: "/w", workerSha256: "f".repeat(64) },
  },
  graphConfig,
);
/** Graph's fake answer: the notes file's first lines, a region the projection maps onto chunks. */
const graphAnswer =
  (path: string): GraphPool =>
  () =>
    Effect.succeed({
      kind: "answered" as const,
      results: [
        {
          identity: {
            tree: "t",
            blobOid: "o",
            path,
            startLine: 1,
            endLine: 3,
            chunkId: "g",
            recipe: "r",
          },
        } as unknown as SearchResult,
      ],
    });
const environment = (
  graph: GraphPool,
  encodeCap?: number,
): HybridEnvironment => ({
  repository,
  config,
  e0: {} as E0Runtime,
  graph: {} as GraphRuntime,
  workers: { encoder, reranker },
  graphPool: () => graph,
  queryVector: (text) =>
    Effect.succeed({ vector: vectorOf(text), cut: [] as Array<string> }),
  prepareNext: (oid) =>
    Effect.sync(() => {
      prepared.push(oid);
      return { made: true, cache: "miss" };
    }),
  ...(encodeCap === undefined ? {} : { encodeCap }),
});

test("commit-time hybrid leads are stored ready, reranked, with provenance, and only read by the review", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  const notes =
    "# Values\n\ncomputeValue labels each value.\n\nTOO LONG for the model, as a fake refusal.\n";
  const c1 = commit("values", { "values.ts": values({}), "notes.md": notes });
  const c2 = commit("change line 5", {
    "values.ts": values({
      5: `export const value5 = computeValue(5, "renamed five");`,
    }),
  });
  const c3 = commit("change line 40", {
    "values.ts": values({
      5: `export const value5 = computeValue(5, "renamed five");`,
      40: `export const value40 = computeValue(40, "renamed forty");`,
    }),
  });
  const location = storeLocationIn(join(directory, "store"));
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const header = (oid: string) =>
          Effect.map(treeOf(repository, oid), (tree) => ({
            oid,
            parents: [run("rev-parse", `${oid}^`)],
            tree,
          }));
        // Before the base's first pass, a job finds too many chunks missing and stores nothing.
        const unready = yield* prepareHybrid(
          environment(graphAnswer("notes.md"), 1),
          yield* header(c2),
        );
        // The first pass over c1's tree (what `neuve hybrid prepare` runs).
        const base = (yield* indexOf(
          repository,
          yield* treeOf(repository, c1),
          captureOutlineSource(),
        )).index;
        const firstPass = yield* encodeChunks(repository, base.chunks, encoder);
        const vectors = yield* localTreeVectors(base, "cpu");
        // A vector is stored under the benchmark's contract with this device, never cuda's key.
        const chunk = base.chunks[vectors.docs[0]!]!;
        const store = yield* Computations.ComputationStore;
        const local = yield* store.lookup(
          Computations.computationKey(
            localChunkSpec(chunk.textSha256, chunk.path, "cpu"),
          ).key,
        );
        const cuda = yield* store.lookup(
          Computations.computationKey(
            benchChunkSpec(chunk.textSha256, chunk.path),
          ).key,
        );
        const prepared = yield* prepareHybrid(
          environment(graphAnswer("notes.md")),
          yield* header(c2),
        );
        const rerankedAfterFirst = calls.reranked;
        const again = yield* prepareHybrid(
          environment(graphAnswer("notes.md")),
          yield* header(c2),
        );
        const rerankedAfterAgain = calls.reranked;
        const settings = {
          ...defaultManifestSettings(1_000_000),
          retriever: config,
        };
        // c1..c2: the line-5 hunk is c2's hunk exactly, so its hybrid leads are ready.
        const ready = yield* rangeManifest(
          repository,
          { baseOid: c1, headOid: c2 },
          settings,
          captureOutlineSource(),
        );
        // c2..c3: c3 was never prepared, so its hunk falls back to keyword leads, disclosed.
        const fallback = yield* rangeManifest(
          repository,
          { baseOid: c2, headOid: c3 },
          settings,
          captureOutlineSource(),
        );
        return {
          unready,
          firstPass,
          vectors,
          local: local._tag,
          cuda: cuda._tag,
          prepared,
          again,
          rerankedAfterFirst,
          rerankedAfterAgain,
          ready: ready.value,
          readyLeads: ready.leads.value,
          fallback: fallback.leads.value,
          base,
        };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );

  expect(result.unready.status).toBe("not-ready");
  expect(result.unready.leads.computed).toBe(0);
  // The refused chunk is recorded as refused, so the tree is ready without it.
  expect(result.firstPass.refused).toBe(1);
  expect(result.vectors.missing).toBe(0);
  expect(result.vectors.refused.length).toBe(1);
  expect(result.local).toBe("Some");
  expect(result.cuda).toBe("None");

  expect(result.prepared.status).toBe("prepared");
  expect(result.prepared.leads.computed).toBe(1);
  // A second run reads the stored leads back and scores nothing.
  expect(result.again.leads).toMatchObject({ computed: 0, reused: 1 });
  expect(result.rerankedAfterAgain).toBe(result.rerankedAfterFirst);

  const hunk = result.ready.hunks.find(
    (entry) => entry.newStart <= 5 && entry.newStart + entry.newLines > 5,
  )!;
  const ranked = leadsByHunk(result.readyLeads).get(hunk.hunkId);
  expect(ranked?.source).toBe("cached");
  expect(result.readyLeads.settings.retriever.id).toBe("hybrid");
  expect(result.readyLeads.counts.fallback).toBe(0);
  const leads = ranked!.results;
  expect(leads.length).toBeGreaterThan(0);
  // The reranker's order: scores never rise down the list, and the top lead is the one it prefers.
  for (let at = 1; at < leads.length; at++)
    expect(leads[at]!.retrieval.score).toBeLessThanOrEqual(
      leads[at - 1]!.retrieval.score,
    );
  expect(leads[0]!.retrieval.retriever).toBe("hybrid");
  // Every lead is a chunk of the tree it was ranked in: citable by its path and lines (3.4).
  const chunks = new Set(
    result.base.chunks.map(
      (chunk) =>
        `${chunk.path}:${chunk.startLine}-${chunk.endLine}:${chunk.chunkId}`,
    ),
  );
  const refused = new Set(
    result.vectors.refused.map((doc) => result.base.chunks[doc]!.chunkId),
  );
  for (const lead of leads) {
    expect(
      chunks.has(
        `${lead.identity.path}:${lead.identity.startLine}-${lead.identity.endLine}:${lead.identity.chunkId}`,
      ),
    ).toBe(true);
    const sources = lead.retrieval.sources!;
    expect(sources.rerank.score).toBe(lead.retrieval.score);
    expect(sources.fused.rank).toBeGreaterThanOrEqual(1);
    // E0 ranks every chunk with a vector, so a lead has no E0 place exactly when it was refused.
    expect(sources.e0 === null).toBe(refused.has(lead.identity.chunkId));
    // Graph named the notes' first lines: only a chunk overlapping them has a Graph place.
    expect(sources.graph !== null).toBe(
      lead.identity.path === "notes.md" && lead.identity.startLine <= 3,
    );
  }
  // The refused notes chunk reached the leads through Graph alone, so provenance shows both.
  expect(leads.some((lead) => refused.has(lead.identity.chunkId))).toBe(true);

  const later = result.fallback.hunks.find((entry) => entry.leads !== null)!;
  expect(later.leads!.results[0]!.retrieval.retriever).toBe("bm25");
  expect(later.leads!.note).toContain("Hybrid leads were not ready");
  expect(result.fallback.counts.fallback).toBe(1);
}, 60_000);

test("a hunk whose Graph search fails is fused without Graph, and its lead says so", async () => {
  const location = storeLocationIn(join(directory, "store-graph"));
  const failing: GraphPool = () =>
    Effect.succeed({
      kind: "failed" as const,
      reason: "the engine exited",
    });
  const outcome = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const head = run("rev-parse", "HEAD~1");
        const parent = run("rev-parse", `${head}^`);
        const base = (yield* indexOf(
          repository,
          yield* treeOf(repository, parent),
          captureOutlineSource(),
        )).index;
        yield* encodeChunks(repository, base.chunks, encoder);
        const report = yield* prepareHybrid(environment(failing), {
          oid: head,
          parents: [parent],
          tree: yield* treeOf(repository, head),
        });
        const manifest = yield* rangeManifest(
          repository,
          { baseOid: parent, headOid: head },
          { ...defaultManifestSettings(1_000_000), retriever: config },
          captureOutlineSource(),
        );
        return { report, manifest: manifest.leads.value };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(outcome.report.leads.computed).toBe(1);
  const lead = outcome.manifest.hunks.find(
    (hunk) => hunk.leads !== null,
  )!.leads!;
  expect(lead.source).toBe("cached");
  expect(lead.note).toContain(
    "Graph had no answer (failed: the engine exited)",
  );
  for (const result of lead.results)
    expect(result.retrieval.sources!.graph).toBeNull();
}, 60_000);

// Why: a measured hybrid review is requested only once the range's commits have no hybrid
// preparation left (the overseer's call), and its Precompute span shows that count. A count that
// took in other ranges' commits or finished jobs would let a measured review freeze fallbacks it
// did not need, or hold one back for nothing.
test("a hybrid review counts its range's commits whose hybrid preparation is still queued or running", async () => {
  const c1 = run("rev-parse", "HEAD~2");
  const c2 = run("rev-parse", "HEAD~1");
  const c3 = run("rev-parse", "HEAD");
  const location = storeLocationIn(join(directory, "store-pending"));
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  const counted = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const enqueue = (oid: string) =>
          queue.enqueue({
            kind: "commit.hybrid",
            dedupeKey: `commit.hybrid:${oid}`,
            payload: {
              oid,
              tree: run("rev-parse", `${oid}^{tree}`),
              parents: [],
            },
          });
        // c1 is the range's base, outside it; c3's job has finished; c2's still waits.
        yield* enqueue(c1);
        yield* enqueue(c3);
        const taken = yield* queue.take(["commit.hybrid"]);
        if (Option.isSome(taken))
          yield* queue.complete(taken.value.seq, taken.value.attempts);
        yield* enqueue(c2);
        const range = { baseOid: c1, headOid: c3 };
        const pending = yield* pendingHybrid(repository, range);
        yield* rangeManifest(
          repository,
          range,
          {
            ...defaultManifestSettings(1_000_000),
            retriever: config,
          },
          captureOutlineSource(),
        );
        return { pending, taken: Option.map(taken, (job) => job.dedupeKey) };
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
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
    ),
  );
  // The newest commit's job is taken first, so c3's is the finished one.
  expect(Option.getOrUndefined(counted.taken)).toBe(`commit.hybrid:${c3}`);
  expect(counted.pending).toEqual({ commits: 2, pending: 1 });
  // The count is on the leads' own span: the leads read the hybrid preparation, the manifest doesn't.
  const span = records.find(
    (record) => record.type === "span" && record["name"] === "harness.leads",
  );
  expect(span?.["attributes"]).toMatchObject({
    "harness.hybrid.range_commits": 2,
    "harness.hybrid.pending_commits": 1,
  });
}, 60_000);

// Why: on this machine one model is resident at a time, so a job encodes and asks every query
// first, closes the encoder, and only then reranks, one hunk at a time; and it pauses before a
// hunk when free disk or swap is past its limit, rather than pushing the machine into the disk
// floor (the measured window of 24 October 2026). A job that skipped the release, overlapped
// reranks or ignored the limits would pass every other test.
test("under a one-model limit the job encodes and asks first, then reranks one hunk at a time, and pauses on the limits", async () => {
  const c3 = run("rev-parse", "HEAD");
  const c4 = commit("two changes", {
    "values.ts": values({
      5: `export const value5 = computeValue(5, "renamed five");`,
      10: `export const value10 = computeValue(10, "renamed ten");`,
      40: `export const value40 = computeValue(40, "renamed forty");`,
      55: `export const value55 = computeValue(55, "renamed fifty-five");`,
    }),
  });
  const order: Array<string> = [];
  let inFlight = 0;
  let overlapped = false;
  const counted: PairReranker = {
    ...reranker,
    score: (query, documents) =>
      Effect.gen(function* () {
        order.push("rerank");
        inFlight++;
        if (inFlight > 1) overlapped = true;
        yield* Effect.sleep("10 millis");
        inFlight--;
        return yield* reranker.score(query, documents);
      }),
  };
  let checks = 0;
  const location = storeLocationIn(join(directory, "store-limits"));
  const report = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const base = (yield* indexOf(
          repository,
          yield* treeOf(repository, c3),
          captureOutlineSource(),
        )).index;
        yield* encodeChunks(repository, base.chunks, encoder);
        return yield* prepareHybrid(
          {
            ...environment(graphAnswer("notes.md")),
            queryVector: undefined,
            workers: {
              encoder,
              reranker: counted,
              encodeQuery: async (text) => {
                order.push("query");
                return {
                  kind: "encoded",
                  items: [{ values: [...vectorOf(text)] }],
                } as never;
              },
              releaseEncoder: () =>
                Effect.sync(() => {
                  order.push("release");
                }),
            },
            models: 1,
            limits: { minFreeDiskBytes: 100, maxSwapUsedBytes: 100 },
            // Room for the first hunk; the swap passes its limit before the second.
            resources: () =>
              ++checks === 1
                ? { freeBytes: 1_000, swapUsedBytes: 10 }
                : { freeBytes: 1_000, swapUsedBytes: 1_000 },
          },
          { oid: c4, parents: [c3], tree: yield* treeOf(repository, c4) },
        );
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(report.status).toBe("paused");
  expect(report.reason).toContain("swap in use");
  // A paused job leaves the next base alone: the machine is short.
  expect(prepared).not.toContain(c4);
  expect(report.leads.computed).toBe(1);
  expect(report.leads.deferred).toBeGreaterThan(0);
  const release = order.indexOf("release");
  expect(order.filter((step) => step === "query").length).toBeGreaterThan(1);
  expect(order.lastIndexOf("query")).toBeLessThan(release);
  expect(order.indexOf("rerank")).toBeGreaterThan(release);
  expect(overlapped).toBe(false);
}, 60_000);

// Why: a job that runs out of its budget with hunks left must carry on rather than hand them to
// keyword fallback (the overseer's call, 25 October 2026), so fallback only means "not ready yet";
// but a run that could store nothing must not requeue itself forever.
test("a job out of budget continues with the hunks left, and stops continuing when it cannot progress", async () => {
  const head = run("rev-parse", "HEAD");
  const parent = run("rev-parse", "HEAD^");
  const location = storeLocationIn(join(directory, "store-continue"));
  const reports = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const base = (yield* indexOf(
          repository,
          yield* treeOf(repository, parent),
          captureOutlineSource(),
        )).index;
        yield* encodeChunks(repository, base.chunks, encoder);
        const header = {
          oid: head,
          parents: [parent],
          tree: yield* treeOf(repository, head),
        };
        const queries = {
          ...environment(graphAnswer("notes.md")),
          queryVector: undefined,
          workers: {
            encoder,
            reranker,
            encodeQuery: async (text: string) =>
              ({
                kind: "encoded",
                items: [{ values: [...vectorOf(text)] }],
              }) as never,
          },
        };
        // No time for any hunk: it encodes its queries, then continues with every hunk left.
        const before = prepared.filter((oid) => oid === head).length;
        const first = yield* prepareHybrid(
          { ...queries, budgetMs: -1 },
          header,
        );
        // A continuing run leaves the next base for the run that finishes.
        const afterFirst =
          prepared.filter((oid) => oid === head).length - before;
        // Nothing left to encode and still no time: no progress, so it stops continuing.
        const stuck = yield* prepareHybrid(
          { ...queries, budgetMs: -1 },
          header,
        );
        // With time, the next run finishes every hunk.
        const done = yield* prepareHybrid(queries, header);
        return { first, stuck, done, afterFirst };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(reports.first.status).toBe("continues");
  expect(reports.afterFirst).toBe(0);
  expect(reports.first.left).toBeGreaterThan(1);
  expect(reports.first.leads.computed).toBe(0);
  expect(reports.stuck.status).toBe("prepared");
  expect(reports.done.status).toBe("prepared");
  expect(reports.done.leads.computed).toBe(reports.first.left!);
  expect(reports.done.leads.deferred).toBe(0);
}, 60_000);

// Why: Graph prepares a base from scratch (about 47 s), so each job prepares its own commit for
// the next commit's job (the overseer's call, 25 October 2026). That must never block or fail the
// job, and its span must say what happened.
test("a job prepares its commit's Graph base for the next one, and never waits on it", async () => {
  const base = environment(graphAnswer("notes.md"));
  const outcome = (prepareNext: NonNullable<typeof base.prepareNext>) =>
    Effect.runPromise(
      prepareNextBase({ ...base, prepareNext }, "c".repeat(40)),
    );
  expect(
    await outcome(() => Effect.succeed({ made: true, cache: "miss" })),
  ).toBe("ready");
  expect(await outcome(() => Effect.succeed({ made: false }))).toBe(
    "already-prepared",
  );
  expect(
    await outcome(() => Effect.succeed({ made: true, cache: "hit" })),
  ).toBe("already-prepared");
  expect(await outcome(() => Effect.fail(new Error("no engine")))).toBe(
    "failed",
  );
  // A job that waited for the preparation would answer "ready", not "started".
  expect(
    await outcome(() =>
      Effect.as(Effect.sleep("5 seconds"), { made: true, cache: "miss" }),
    ),
  ).toBe("started");
  // The first test's jobs asked for their own commits.
  expect(prepared.length).toBeGreaterThan(0);
}, 30_000);
