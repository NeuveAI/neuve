import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: the fakes in hybrid-leads.test.ts stand in for two real processes whose failure would be
// silent at the review: an encoder that returns vectors of the wrong model or device, a reranker
// whose identity or prompt drifted from the benchmark's, or processes that leak or never report
// what they cost (10.97). With the models on this machine (the environment names them), this runs
// the real encoder and reranker on a small repository and a scratch store, never a live one.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { prepareHybrid, prepareTreeVectors } from "../src/commit-hybrid.ts";
import type { E0Runtime } from "../src/e0.ts";
import type { GraphRuntime } from "../src/graph-search.ts";
import { closeHybridWorkers, hybridWorkers } from "../src/hybrid-models.ts";
import type { GraphPool } from "../src/hybrid.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { hybridConfigFor } from "../src/search-config.ts";
import { treeOf } from "../src/git-objects.ts";

const python = process.env["NEUVE_HYBRID_TEST_PYTHON"];
const e0Snapshot = process.env["NEUVE_HYBRID_TEST_E0_SNAPSHOT"];
const rerankerSnapshot = process.env["NEUVE_HYBRID_TEST_RERANKER_SNAPSHOT"];
const device = (process.env["NEUVE_HYBRID_TEST_DEVICE"] ?? "cpu") as
  "cpu" | "mps";
const live =
  python !== undefined &&
  e0Snapshot !== undefined &&
  rerankerSnapshot !== undefined;

const directory = mkdtempSync(join(tmpdir(), "harness-hybrid-models-"));
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

const semanticWorker = new URL(
  "../../semantic-client/src/worker.py",
  import.meta.url,
).pathname;
const rerankerWorker = new URL(
  "../../semantic-client/src/reranker_worker.py",
  import.meta.url,
).pathname;

test.skipIf(!live)(
  "the real encoder and reranker prepare a commit's hybrid leads, and say what they cost",
  async () => {
    Bun.spawnSync(["git", "init", "-q", repository]);
    const sort = `export const sortValues = (values: Array<number>) =>\n  [...values].sort((a, b) => a - b);\n`;
    const c1 = commit("sorting", {
      "sort.ts": sort,
      "README.md": "# Sorting\n\nsortValues returns a sorted copy.\n",
    });
    const c2 = commit("descending", {
      "sort.ts": sort.replace("a - b", "b - a"),
    });
    const e0: E0Runtime = {
      python: python!,
      snapshot: e0Snapshot!,
      worker: semanticWorker,
      vectorStore: directory,
    };
    const workerSha256 = createHash("sha256")
      .update(readFileSync(rerankerWorker))
      .digest("hex");
    const runtime = {
      prepare: true,
      device,
      e0,
      graph: {} as GraphRuntime,
      models: 1,
      limits: {
        minFreeDiskBytes: 1,
        maxSwapUsedBytes: Number.MAX_SAFE_INTEGER,
      },
      reranker: {
        snapshot: rerankerSnapshot!,
        worker: rerankerWorker,
        workerSha256,
      },
    };
    const config = hybridConfigFor(runtime, {
      id: "graph",
      engine: {
        sha256: "b".repeat(64),
        provider: "fake",
        version: "0",
        identityRevision: "r",
      },
      profile: "full",
      topK: 50,
    });
    const noGraph: GraphPool = () =>
      Effect.succeed({
        kind: "failed" as const,
        reason: "no Graph in this test",
      });
    const records: Array<RunLogRecord> = [];
    const log = {
      path: "",
      write: (record: RunLogRecord) => {
        records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
      },
      read: () => records,
    };
    const location = storeLocationIn(join(directory, "store"));
    const result = await Effect.runPromise(
      Effect.andThen(
        Store.prepareForWrite,
        Effect.gen(function* () {
          const workers = yield* hybridWorkers({ runtime, e0 });
          const first = yield* prepareTreeVectors(
            repository,
            c1,
            workers.encoder,
          );
          const report = yield* prepareHybrid(
            {
              repository,
              config,
              e0,
              graph: {} as GraphRuntime,
              workers,
              graphPool: () => noGraph,
              models: runtime.models,
            },
            { oid: c2, parents: [c1], tree: yield* treeOf(repository, c2) },
          );
          const manifest = yield* rangeManifest(
            repository,
            { baseOid: c1, headOid: c2 },
            { ...defaultManifestSettings(1_000_000), retriever: config },
            captureOutlineSource(),
          );
          return { first, report, manifest: manifest.leads.value };
        }).pipe(Effect.ensuring(closeHybridWorkers)),
      ).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
        Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      ),
    );
    expect(result.first.after.missing).toBe(0);
    expect(result.first.encoded).toBe(result.first.chunks);
    expect(result.report.status).toBe("prepared");
    expect(result.report.leads.computed).toBe(1);
    const leads = result.manifest.hunks.find(
      (hunk) => hunk.leads !== null,
    )!.leads!;
    expect(leads.source).toBe("cached");
    expect(leads.results[0]!.retrieval.retriever).toBe("hybrid");
    for (const lead of leads.results) {
      const score = lead.retrieval.sources!.rerank.score;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // The changed function is the lead the reranker puts first.
    expect(leads.results[0]!.identity.path).toBe("sort.ts");
    // Each process's start, load and memory are on the span of the call that started it.
    const spans = records.filter((record) => record.type === "span");
    const started = (name: string) =>
      spans.find(
        (span) =>
          span["name"] === name &&
          (span["attributes"] as Record<string, unknown>)[
            "harness.hybrid.model.started"
          ] === true,
      )?.["attributes"] as Record<string, unknown> | undefined;
    for (const name of [
      "harness.hybrid.encode.batch",
      "harness.hybrid.rerank",
    ]) {
      const attributes = started(name);
      expect(attributes?.["harness.hybrid.model.load_ms"]).toBeGreaterThan(0);
      expect(attributes?.["harness.hybrid.model.memory_bytes"]).toBeGreaterThan(
        0,
      );
    }
  },
  600_000,
);
