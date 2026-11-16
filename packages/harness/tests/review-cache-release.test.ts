// Why (NEU-148, the worker's memory): a worker kept its two tree indexes and its two decoded
// relations indexes after every review, about 2.4 GB on t3code, until it exited. When the last
// review running in the process ends, both caches must be empty, and the next call must build or
// decode the same value again from the store. A review still running must keep them, also while it
// only waits on a child task. These drive the real review task on a real pi Harness, with stand-in
// stages, and the real tree index and relations lookups against a real Records store.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime, Tracer } from "effect";
import type { GraphSnapshotCoverage } from "@neuve/graph-client";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CodeWork } from "../src/code-work.ts";
import type { OutlineSource } from "../src/graph-outline.ts";
import type { PrecomputeOutput, StageRecord } from "../src/pipeline.ts";
import type { ReviewStagesPort } from "../src/pi/review-task.ts";
import type { FrontInput, FrontResult } from "../src/pi/stages/front-task.ts";
import type { LeadsInput, LeadsResult } from "../src/pi/stages/leads-task.ts";
import {
  RelationsIndexBuilder,
  isRelationsGap,
  relationsIndexDecodes,
  relationsSpec,
  storedRelations,
} from "../src/relations.ts";
import * as SearchIndex from "../src/search-index.ts";

// Each release of the tree-index cache, as the review task makes it: the event a test waits for
// where a review's last phase ends with no terminal receipt to wait on.
const releases: Array<() => void> = [];
const released = () =>
  new Promise<void>((resolve) => {
    releases.push(resolve);
  });
// Taken before the mock: the namespace's binding then names the mock.
const { releaseIndexCache, treeIndex } = SearchIndex;
mock.module("../src/search-index.ts", () => ({
  ...SearchIndex,
  releaseIndexCache: () => {
    releaseIndexCache();
    for (const resolve of releases.splice(0)) resolve();
  },
}));
const { childOf, reviewExtension, reviewTask } =
  await import("../src/pi/review-task.ts");

const root = mkdtempSync(join(tmpdir(), "review-cache-release-"));
const location = storeLocationIn(join(root, "records"));
const store = ManagedRuntime.make(
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  ),
);
afterAll(async () => {
  await store.dispose();
  rmSync(root, { recursive: true, force: true });
});

// The tree index side, as degraded-index-cache.test.ts builds it: a real repository, no Graph.
const repository = join(root, "repo");
const git = (args: string[], input?: string) => {
  const child = Bun.spawnSync(["git", "-C", repository, ...args], {
    ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
Bun.spawnSync(["git", "init", "-q", repository]);
const tree = (path: string, text: string) =>
  git(
    ["mktree"],
    `100644 blob ${git(["hash-object", "-w", "--stdin"], text)}\t${path}\n`,
  );
/** Graph is not installed at this path: a code file's index is degraded, Markdown's is healthy. */
const NO_GRAPH: OutlineSource = {
  executable: join(root, "absent-graph"),
  key: { unavailable: join(root, "absent-graph") },
};
let builds = 0;
const counting = Tracer.make({
  span: (options) => {
    if (options.name === "harness.index.tree") builds++;
    return Tracer.nativeTracer.span(options);
  },
});
const indexOf = (
  revision: string,
  work?: { directory: string; background: boolean },
) =>
  store.runPromise(
    treeIndex(repository, revision, NO_GRAPH).pipe(
      Effect.provideService(CodeWork, work),
      Effect.provideService(Tracer.Tracer, counting),
    ),
  );

// The relations side, as relations-memo.test.ts stores it: one finished computation per commit.
const ENGINE: OutlineSource = {
  executable: join(tmpdir(), "absent-engine"),
  key: { sha256: "e".repeat(64) },
};
const coverage: GraphSnapshotCoverage = {
  provider: {
    name: "entire-graph",
    version: "fixture",
    identityRevision: "4",
    executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  },
  repoKey: "local/r",
  schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  profile: "full",
  relationSet: ["CALLS", "CONSTRUCTS", "IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { TypeScript: "semantic" },
  counts: { files: 1, parsedFiles: 1, symbols: 1, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
};
const storeRelations = async (commit: string, name: string) => {
  const builder = new RelationsIndexBuilder();
  builder.file({
    id: "file:a.ts",
    path: "a.ts",
    language: "TypeScript",
    bytes: 1,
  });
  builder.symbol({
    id: name,
    name,
    qualifiedName: name,
    kind: "function",
    language: "TypeScript",
    path: "a.ts",
    startLine: 1,
    endLine: 2,
    containerId: null,
    signature: null,
  });
  const index = await builder.finish(coverage);
  await store.runPromise(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      yield* computations.run(
        relationsSpec(commit, ENGINE),
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(index)),
          mediaType: "application/json",
        }),
      );
    }),
  );
  return index;
};
const relationsOf = async (commit: string) => {
  const side = (
    await store.runPromise(
      storedRelations({ base: commit, head: commit, source: ENGINE }),
    )
  ).head;
  if (isRelationsGap(side)) throw new Error(`no relations: ${side}`);
  return side;
};
const decodes = () => Effect.runSync(relationsIndexDecodes);

/** Each cache, with what the last lookup cost: a build or decode, or none. */
const probe = async (revisions: ReadonlyArray<string>, commit: string) => {
  const builtBefore = builds;
  const decodedBefore = decodes();
  const indexes = [];
  for (const revision of revisions) indexes.push(await indexOf(revision));
  const relations = await relationsOf(commit);
  return {
    indexes,
    relations,
    built: builds - builtBefore,
    decoded: decodes() - decodedBefore,
  };
};

// The review side: the real review task with stand-in stages, one Harness per review.
const record = (stage: StageRecord["stage"], agent: string): StageRecord => ({
  stage,
  agent,
  status: "computed",
  wallMs: 1,
});
const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};
const PRECOMPUTE = {
  files: [],
  diffBytes: 0,
  manifest: "manifest-key",
  scope: "scope-key",
  hunks: 1,
  reviewLines: 1,
  strongestStratum: "nothing",
  scopeGaps: [],
} as unknown as PrecomputeOutput;

/**
 * One review on its own Harness, by how it goes:
 * - `wait`: Precompute gives facts, so the review commits to wait on its front task, which ends
 *   (with no Frame, straight to Publish) only when `release` opens; the review then runs no phase
 *   while it waits.
 * - `leads`: as `wait`, and the review also starts a leads task, which it never waits for and which
 *   ends only when `end` is called, so Publish's outcome holds as `completing` until then.
 * - `publish`: Precompute gives none and the review goes to Publish, which ends only when `release`
 *   opens.
 * - `throw`: as `publish`, and then the publish stage throws, so the phase throws.
 */
const startReview = async (
  name: string,
  how: "wait" | "leads" | "publish" | "throw",
) => {
  const waits = how === "wait" || how === "leads";
  const release = gate();
  const reached = gate();
  const leadsEnd = gate();
  const leads = defineTask<LeadsInput, { phase: "run" }, LeadsResult>({
    name: `test.leads.${name}`,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        await leadsEnd.opened;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { status: "stored", key: "leads-key" },
            },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  const front = defineTask<FrontInput, { phase: "run" }, FrontResult>({
    name: `test.front.${name}`,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        reached.open();
        await release.opened;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                stages: [record("frame", "frame")],
                frameKey: null,
                mapKey: null,
                manifestKey: "manifest-key",
                scopeKey: "scope-key",
                strongestStratum: "nothing",
                frameStratum: "nothing",
                disclosures: [],
                reason: "the frame is unavailable",
              },
            },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  const port: ReviewStagesPort = {
    front: childOf(front),
    ...(how === "leads" ? { leads: childOf(leads) } : {}),
    precompute: async () =>
      waits
        ? {
            record: record("precompute", "precompute"),
            facts: { key: "precompute-key", output: PRECOMPUTE },
          }
        : { record: record("precompute", "precompute") },
    fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
    link: async () => {
      throw new Error("no review here reaches Link");
    },
    publish: async () => {
      if (!waits) {
        reached.open();
        await release.opened;
      }
      if (how === "throw") throw new Error("the publish stage failed");
      return [record("publish", "publish")];
    },
  };
  const review = reviewTask(port);
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: `test.stages.${name}`, tasks: [front, leads] }),
  );
  registry.install(reviewExtension(review));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const conversation = await harness.root(context);
  const id: TaskId = await harness.commit(
    (tx) =>
      tx.createTask(
        review,
        {
          range: {
            baseRef: "main",
            baseOid: "1".repeat(40),
            headOid: "2".repeat(40),
          },
          config: {} as never,
          runKey: "c".repeat(64),
          runId: `01KA00000000000000000000${name.toUpperCase().padStart(2, "0")}`,
          cycleId: "01KA0000000000000000000001",
          generation: 0,
          cutoffAt: Date.now() + 600_000,
        },
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
        },
      ),
    context,
  );
  harness.resume();
  const ended = harness.waitForTask(id, context);
  await reached.opened;
  return {
    /** Opens `release` only: the review goes on, and a leads task it started still runs. */
    release: () => release.open(),
    status: async () => (await harness.getTask(id, context))?.state.status,
    abort: () => harness.abortTask(id, context),
    /** Lets the review end, and resolves once it is terminal and its Harness closed. */
    end: async (outcome: "completed" | "aborted" | "faulted" = "completed") => {
      release.open();
      leadsEnd.open();
      const done = await ended;
      await harness.close(context);
      expect(done.state.outcome.status).toBe(outcome);
    },
  };
};

// The regression: both caches outlived the review until the process exited.
test("when the review ends, both caches are empty and the next lookups give the same values again", async () => {
  const healthy = tree("plan.md", "# Plan\nhealthy body\n");
  const degraded = tree("degraded.ts", "export const degraded = 1;\n");
  const commit = "4".repeat(40);
  const stored = await storeRelations(commit, "first");
  const review = await startReview("a", "publish");
  const first = await probe([healthy, degraded], commit);
  expect(first.built).toBe(2);
  expect(first.decoded).toBe(1);
  // While the review runs, both are served from the caches.
  const held = await probe([healthy, degraded], commit);
  expect(held.built).toBe(0);
  expect(held.decoded).toBe(0);
  expect(held.relations).toBe(first.relations);
  expect(held.indexes.map((r) => r.index)).toEqual(
    first.indexes.map((r) => r.index),
  );
  await review.end();
  // The review ended: the healthy and the degraded index went, and the decoded relations index.
  const after = await probe([healthy, degraded], commit);
  expect(after.built).toBe(2);
  expect(after.decoded).toBe(1);
  expect(after.indexes.map((r) => r.cached)).toEqual([false, false]);
  // Built or decoded again from the store: a new object, the same value.
  expect(after.relations).not.toBe(first.relations);
  expect(after.relations).toEqual(stored);
  for (const [at, result] of after.indexes.entries()) {
    const before = first.indexes[at]!.index;
    expect(result.index).not.toBe(before);
    expect(result.index.chunks).toEqual(before.chunks);
    expect(result.index.postings).toEqual(before.postings);
    expect(result.index.tree).toBe(before.tree);
  }
});

// Two reviews in one process: the first one's end must not throw away what the second still uses,
// also while the second runs no phase and only waits on its front task.
test("the first of two reviews to end keeps the caches; the last one's end empties them", async () => {
  const revision = tree("second.md", "# Second\nbody\n");
  const commit = "5".repeat(40);
  await storeRelations(commit, "second");
  const waiting = await startReview("b", "wait");
  const publishing = await startReview("c", "publish");
  const first = await probe([revision], commit);
  expect(first.built).toBe(1);
  expect(first.decoded).toBe(1);
  await publishing.end();
  const kept = await probe([revision], commit);
  expect(kept.built).toBe(0);
  expect(kept.decoded).toBe(0);
  expect(kept.indexes[0]!.index).toBe(first.indexes[0]!.index);
  expect(kept.relations).toBe(first.relations);
  await waiting.end();
  const after = await probe([revision], commit);
  expect(after.built).toBe(1);
  expect(after.decoded).toBe(1);
  expect(after.indexes[0]!.index.chunks).toEqual(
    first.indexes[0]!.index.chunks,
  );
  expect(after.relations).toEqual(first.relations);
});

// Why (review verdicts): the count also falls when a phase throws, when the abort handler ends, and
// when the last phase leaves the review `completing` while a child it never waits for still runs.
// Each is the last review here, so each must release the caches; were one of them missed, the
// caches would stay until the process exits.
test("a review whose phase throws releases the caches when it was the last", async () => {
  const revision = tree("thrown.md", "# Thrown\nbody\n");
  const commit = "6".repeat(40);
  await storeRelations(commit, "thrown");
  const review = await startReview("d", "throw");
  const first = await probe([revision], commit);
  expect(first.built).toBe(1);
  expect(first.decoded).toBe(1);
  await review.end("faulted");
  const after = await probe([revision], commit);
  expect(after.built).toBe(1);
  expect(after.decoded).toBe(1);
});

test("an aborted review releases the caches when its abort handler ends", async () => {
  const revision = tree("aborted.md", "# Aborted\nbody\n");
  const commit = "7".repeat(40);
  await storeRelations(commit, "aborted");
  // It waits on its front task: no phase of it runs, so only its abort handler can end it.
  const review = await startReview("e", "wait");
  const first = await probe([revision], commit);
  expect(first.built).toBe(1);
  expect(first.decoded).toBe(1);
  expect(await review.abort()).toBe("marked");
  await review.end("aborted");
  const after = await probe([revision], commit);
  expect(after.built).toBe(1);
  expect(after.decoded).toBe(1);
});

test("a review whose last phase leaves it completing releases the caches while its child runs", async () => {
  const revision = tree("completing.md", "# Completing\nbody\n");
  const commit = "8".repeat(40);
  await storeRelations(commit, "completing");
  const review = await startReview("f", "leads");
  const first = await probe([revision], commit);
  expect(first.built).toBe(1);
  expect(first.decoded).toBe(1);
  const release = released();
  review.release();
  await release;
  // Publish committed the outcome; the leads task still runs, so the review is `completing`.
  expect(await review.status()).toBe("completing");
  const after = await probe([revision], commit);
  expect(after.built).toBe(1);
  expect(after.decoded).toBe(1);
  await review.end();
});

// Why (review of the release): once a release empties the cache, the next calls for the same tree
// read its snapshot file. Each call not joined to another decoded its own copy, so finders of one
// review held several. The first read must be kept as a built index is, so the calls after it share
// that one copy.
test("after a release, calls that read the same snapshot share one copy", async () => {
  const revision = tree("snapshot.md", "# Snapshot\nbody\n");
  const work = { directory: join(root, "code-work"), background: false };
  const first = await indexOf(revision, work);
  expect(first.cached).toBe(false);
  // The build wrote its snapshot file, which the calls after the release read as it is.
  const folder = join(work.directory, "code-work", "indexes");
  const [name] = readdirSync(folder).filter((file) => file.endsWith(".index"));
  if (name === undefined) throw new Error("no snapshot");
  releaseIndexCache();
  const builtBefore = builds;
  const reads = [];
  for (let call = 0; call < 3; call++)
    reads.push(await indexOf(revision, work));
  expect(builds - builtBefore).toBe(0);
  expect(reads.map((read) => read.cached)).toEqual([true, true, true]);
  // One copy: every call after the first is given the index the first one read.
  expect(reads[1]!.index).toBe(reads[0]!.index);
  expect(reads[2]!.index).toBe(reads[0]!.index);
  expect(reads[0]!.index).not.toBe(first.index);
  expect(reads[0]!.index.chunks).toEqual(first.index.chunks);
  releaseIndexCache();
});
