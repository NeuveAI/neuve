import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: Preparation's sub-steps are spans now (10.97), and a reader of a slow review's preparation
// (the attribution report, an OTLP viewer) places each step by its parent span. A step whose span
// opened under the wrong parent, or none, reads as Neuve's own untimed time, and nothing else would
// show it; the per-hunk leads timings are metrics, which must be recorded. This computes a real
// range's manifest over a small repository through the run log's tracer and checks the tree.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Metric, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { writeMetrics } from "../src/telemetry.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-prep-spans-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
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

const commit = (message: string, text: string) => {
  writeFileSync(join(repository, "values.ts"), text);
  git("add", "values.ts");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

const source = (changes: Record<number, string>) =>
  Array.from(
    { length: 40 },
    (_, index) =>
      changes[index + 1] ??
      `export const value${index + 1} = computeValue(${index + 1});`,
  ).join("\n") + "\n";

test("the manifest's sub-steps are spans nested under it, with counts, and the leads timings are metrics", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  const base = commit("values", source({}));
  const head = commit(
    "two changes",
    source({
      5: "export const value5 = computeValue(55);",
      30: "export const value30 = computeValue(330);",
    }),
  );
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  const registry: Metric.MetricRegistry = new Map();
  const location = storeLocationIn(join(directory, "store"));
  await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      ),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  );
  const spans = records.filter((record) => record.type === "span");
  const byName = (name: string) => {
    const found = spans.filter((span) => span["name"] === name);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const childrenOf = (parent: RunLogRecord) =>
    spans
      .filter((span) => span["parentSpanId"] === parent["spanId"])
      .sort((a, b) => String(a["start"]).localeCompare(String(b["start"])))
      .map((span) => span["name"]);
  const manifest = byName("harness.precompute.manifest");
  expect(childrenOf(manifest)).toEqual([
    "harness.precompute.merge-base",
    "harness.precompute.trees",
    "harness.precompute.range-diff",
    "harness.precompute.hunks",
    "harness.precompute.listings",
    "harness.precompute.declarations",
    "harness.precompute.assembly",
  ]);
  expect(manifest["attributes"]).toMatchObject({
    "harness.computation.status": "computed",
  });
  // The leads are their own computation, with their own steps, after the manifest (NEU-148).
  const leads = byName("harness.leads");
  expect(childrenOf(leads)).toEqual([
    "harness.leads.lookup",
    "harness.leads.tree-index",
    "harness.leads.retriever",
    "harness.leads.round",
    "harness.leads.assembly",
  ]);
  expect(leads["attributes"]).toMatchObject({
    "harness.computation.status": "computed",
    "harness.retriever": "bm25",
  });
  // The shared run stays under its preparation step, and the actual build under that run.
  const shared = spans.find(
    (span) =>
      span["name"] === "harness.index.shared" &&
      span["parentSpanId"] === byName("harness.leads.tree-index")["spanId"],
  )!;
  expect(shared).toBeDefined();
  const index = spans.find(
    (span) =>
      span["name"] === "harness.index.tree" &&
      span["parentSpanId"] === shared["spanId"],
  )!;
  expect(index).toBeDefined();
  expect(childrenOf(index)).toEqual([
    "harness.index.list",
    "harness.index.chunk",
    "harness.index.declarations",
    "harness.index.postings",
  ]);
  const attributes = (name: string) =>
    byName(name)["attributes"] as Record<string, unknown>;
  expect(attributes("harness.precompute.range-diff")).toEqual({
    "harness.files": 1,
  });
  const hunks = attributes("harness.precompute.hunks")["harness.hunks"];
  expect(hunks).toBe(2);
  expect(attributes("harness.leads.round")).toEqual({
    "harness.retriever": "bm25",
    "harness.hunks": 2,
    "harness.from_store": 0,
  });
  // The step ends where its last sub-step does, not before.
  const end = (span: RunLogRecord) =>
    Date.parse(String(span["start"])) + (span["durationMs"] as number);
  expect(end(manifest)).toBeGreaterThanOrEqual(
    end(byName("harness.precompute.assembly")) - 1,
  );
  expect(end(leads)).toBeGreaterThanOrEqual(
    end(byName("harness.leads.assembly")) - 1,
  );

  const metrics: Array<RunLogRecord> = [];
  writeMetrics(
    { path: "", write: (record) => metrics.push(record), read: () => [] },
    registry,
  );
  const count = (name: string) =>
    metrics
      .filter((record) => record["name"] === name)
      .map((record) => ({
        attributes: record["attributes"],
        count: (record["state"] as { count: number }).count,
      }));
  expect(count("harness.leads.hunk.duration")).toEqual([
    { attributes: { "harness.retriever": "bm25", unit: "s" }, count: 2 },
  ]);
  expect(
    count("harness.leads.search.duration").every(
      (entry) =>
        (entry.attributes as Record<string, string>)["harness.retriever"] ===
          "bm25" && entry.count >= 2,
    ),
  ).toBe(true);
  // Counts and labels only: no source text in a span.
  expect(JSON.stringify(records)).not.toContain("computeValue");
}, 60_000);
