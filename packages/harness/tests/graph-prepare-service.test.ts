import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: with the service setting on, Graph runs a base's preparation in the shared service's own lane,
// as a child process of the service, and reports the child's exact CPU in the index receipt's
// `service` block; the command this process ran only forwarded it. The preparation's CPU must then
// come from that block, as a search's does, or the preparation would look nearly free, and the block
// must be kept once, on the search that started the preparation, not on every search that reuses
// the base. A real engine's CPU cannot be set on cue, so this runs graph-client's fake engine, whose
// index reports a fixed answered block.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  fakeExecutable,
  removeRoots,
} from "../../graph-client/tests/graph-client-support.ts";
import {
  GRAPH_EVENTS,
  GRAPH_SEARCH_SPAN,
  GRAPH_WHOLE_ANSWER,
  graphSearchesInFlight,
} from "../src/graph-search.ts";
import { retrieverFor } from "../src/retrievers.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { graphConfigFor } from "../src/search-config.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-graph-prepare-"));
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

test("a base's preparation takes its CPU from the service's block, kept once on the search that started it", async () => {
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
  const runtime = {
    graph: {
      executable: await fakeExecutable("prepared-service-answered"),
      workDirectory: join(directory, "graph"),
    },
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
  // Whatever the fake's query answers: only the preparation is under test here.
  const search = (text: string) =>
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
          graphDeadlineMs: GRAPH_WHOLE_ANSWER,
        },
        config,
      );
      return yield* Effect.result(
        retriever.search({ text, sha256: "0".repeat(64), limit: 5 }),
      );
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
      Effect.provideService(Tracer.Tracer, runLogTracer(log)),
    );
  const settled = async () => {
    while ((await Effect.runPromise(graphSearchesInFlight)) > 0)
      await Bun.sleep(50);
  };
  await Effect.runPromise(search("where is alpha"));
  await settled();
  await Effect.runPromise(search("where is beta"));
  await settled();

  const ready = records
    .filter(
      (record) =>
        record.type === "span" && record["name"] === GRAPH_SEARCH_SPAN,
    )
    .map(
      (record) =>
        (
          record["events"] as Array<{
            name: string;
            attributes?: Record<string, unknown>;
          }>
        ).find((event) => event.name === GRAPH_EVENTS.baseReady)?.attributes,
    );
  expect(ready).toHaveLength(2);
  const [made, reused] = ready;
  expect(made).toMatchObject({
    "harness.graph.cpu.user_ms": 1500,
    "harness.graph.cpu.system_ms": 250,
    "harness.graph.service.answered": true,
    "harness.graph.service.lane": "prepare",
    "harness.graph.service.class": "background",
    "harness.graph.service.queue_wait_ms": 7,
    "harness.graph.service.max_rss_bytes": 314572800,
  });
  // A preparation reads no snapshot, so Graph leaves snapshot_hit out.
  expect(made?.["harness.graph.service.snapshot_hit"]).toBeUndefined();
  // What this process's own commands used is kept apart, as for a search the service answered.
  expect(typeof made?.["harness.graph.client.cpu.user_ms"]).toBe("number");
  expect(Number(made?.["harness.graph.commands"])).toBeGreaterThan(0);
  // The second search found the base prepared: nothing of the preparation is counted again.
  expect(reused).toBeUndefined();
}, 60_000);
