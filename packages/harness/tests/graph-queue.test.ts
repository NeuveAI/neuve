import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: the shared Graph service queues each call by its class and stops waiting at the caller's
// deadline (the engine's exit 75) while the search runs on and keeps its answer (0013). A review's
// search must ask as interactive with the review's remaining wait, background work as background
// with none, and an exit 75 must come back as Graph still working (a disclosed fallback, recorded on
// the search's span), never as Graph unavailable, or reviews would report a broken Graph whenever
// the service was busy. A real engine cannot be made to miss a deadline on cue, so this runs
// graph-client's fake engine, which exits 75 whenever it is given a deadline.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Metric, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  fakeExecutable,
  removeRoots,
} from "../../graph-client/tests/graph-client-support.ts";
import {
  GRAPH_SEARCH_SPAN,
  GRAPH_WHOLE_ANSWER,
  graphSearchesInFlight,
} from "../src/graph-search.ts";
import { retrieverFor } from "../src/retrievers.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { graphConfigFor } from "../src/search-config.ts";
import { writeMetrics } from "../src/telemetry.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-graph-queue-"));
afterEach(removeRoots);
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

test("a review's search asks as interactive with its wait, background work as background, and exit 75 is Graph still working", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  writeFileSync(join(repository, "source.custom"), "alpha\n");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    "base",
  );
  const base = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const engine = await fakeExecutable("prepared-service-deadline");
  const seen = async () =>
    JSON.parse(
      await Bun.file(join(dirname(engine), "deadline-env")).text(),
    ) as { class: string | null; deadline: string | null };
  const runtime = {
    graph: { executable: engine, workDirectory: join(directory, "graph") },
    frozen: new Map<string, string>(),
    problems: {},
  };
  const records: Array<RunLogRecord> = [];
  const log = {
    path: "",
    write: (record: RunLogRecord) => {
      records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
    },
    read: () => records,
  };
  const location = storeLocationIn(join(directory, "store"));
  const registry: Metric.MetricRegistry = new Map();
  const search = (waitMs: number, text: string) =>
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const config = yield* graphConfigFor(runtime.graph);
      const { retriever } = yield* retrieverFor(
        {
          repository,
          source: captureOutlineSource(),
          tree,
          commit: base,
          runtime,
          graphDeadlineMs: waitMs,
        },
        config,
      );
      return yield* Effect.flip(
        retriever.search({ text, sha256: "0".repeat(64), limit: 5 }),
      );
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      Effect.provideService(Metric.MetricRegistry, registry),
    );

  // Searches outlive their callers; the span and metrics are written when the search itself ends.
  const settled = async () => {
    while ((await Effect.runPromise(graphSearchesInFlight)) > 0)
      await Bun.sleep(50);
  };
  const waited = await Effect.runPromise(search(4_000, "where is alpha"));
  await settled();
  expect((waited as { _tag?: string })._tag).toBe("GraphPending");
  const review = await seen();
  expect(review.class).toBe("interactive");
  expect(Number(review.deadline)).toBeGreaterThan(0);
  expect(Number(review.deadline)).toBeLessThanOrEqual(4_000);
  const spans = records.filter(
    (record) => record.type === "span" && record["name"] === GRAPH_SEARCH_SPAN,
  );
  expect(spans.length).toBeGreaterThan(0);
  expect(spans[0]?.["attributes"]).toMatchObject({
    "harness.graph.queue.class": "interactive",
    "harness.graph.service.deadline": true,
  });
  // Counted as a deadline, not as a gap in Graph.
  writeMetrics(log, registry);
  expect(
    records.some(
      (record) =>
        record.type === "metric" &&
        record["name"] === "harness.graph.search.duration" &&
        JSON.stringify(record).includes('"harness.status":"deadline"'),
    ),
  ).toBe(true);

  // Background work joining a review's search that ends at the review's deadline asks again, as
  // background with no deadline, rather than being failed early (here the engine then fails).
  const [review2, whole] = await Effect.runPromise(
    Effect.all(
      [
        search(4_000, "where is gamma"),
        Effect.delay(
          search(GRAPH_WHOLE_ANSWER, "where is gamma"),
          "100 millis",
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );
  await settled();
  expect((review2 as { _tag?: string })._tag).toBe("GraphPending");
  expect((whole as { _tag?: string })._tag).toBe("GraphUnavailable");
  expect(await seen()).toEqual({ class: "background", deadline: null });

  // Background work waits for the whole answer: no deadline, and a failed engine is a failure.
  const background = await Effect.runPromise(
    search(GRAPH_WHOLE_ANSWER, "where is beta"),
  );
  expect((background as { _tag?: string })._tag).toBe("GraphUnavailable");
  expect(await seen()).toEqual({ class: "background", deadline: null });
}, 60_000);
