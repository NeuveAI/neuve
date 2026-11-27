import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: 10.108 moves Graph's lead searches to commit time and records where a Graph search's time
// and CPU go. Both rest on the real engine: its search `stats`, its process's resource usage, and
// a lead stored under the key a review then looks up. A fake engine would prove only the parser
// (graph-client's own tests do that). This runs the worker's own commit preparation child
// (`neuve worker prepare-commit`) with settings that take leads from Graph, then, in this process
// as the worker's review would, computes the range's manifest: the review must find the lead ready
// without searching Graph, the lead search must use its own clone, and a review-time search must carry Graph's
// timings, the child's CPU and the two waits. It runs only where the engine is built
// (`bun run build:graph`).
import { afterAll, expect, test } from "bun:test";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Metric, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import {
  COMMIT_GRAPH_DIRECTORY,
  prepareCommitArgs,
} from "../src/commit-prepare.ts";
import { GRAPH_EVENTS, GRAPH_SEARCH_SPAN } from "../src/graph-search.ts";
import { retrieverFor } from "../src/retrievers.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { graphConfigFor, setSearchRuntime } from "../src/search-config.ts";
import { settingsPath } from "../src/settings.ts";
import { writeMetrics } from "../src/telemetry.ts";

const cli = resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts");
const engine = resolve(
  import.meta.dir,
  "../../../apps/neuve-graph/entire-graph",
);
const directory = mkdtempSync(join(tmpdir(), "harness-graph-leads-"));
afterAll(() => {
  setSearchRuntime({ frozen: new Map(), problems: {} });
  rmSync(directory, { recursive: true, force: true });
});

const repository = join(directory, "repo");
const spansNamed = (records: ReadonlyArray<RunLogRecord>, name: string) =>
  records.filter((record) => record.type === "span" && record["name"] === name);
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
const commit = (message: string) => {
  run("add", "-A");
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

const graphPrerequisite = graphTestPrerequisite({
  available: existsSync(engine),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

test.skipIf(graphPrerequisite.skip)(
  "Graph's leads are searched at commit time with their timings and CPU, and the review finds them ready",
  async () => {
    graphPrerequisite.require();
    Bun.spawnSync(["git", "init", "-q", repository]);
    writeFileSync(
      join(repository, "pricing.ts"),
      "export function applyDiscount(total: number, rate: number): number {\n  return total - total * rate;\n}\n\nexport function roundCents(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n",
    );
    writeFileSync(
      join(repository, "checkout.ts"),
      'import { applyDiscount, roundCents } from "./pricing.ts";\n\nexport function checkoutTotal(total: number): number {\n  return roundCents(applyDiscount(total, 0.1));\n}\n',
    );
    const base = commit("base");
    writeFileSync(
      join(repository, "checkout.ts"),
      'import { applyDiscount, roundCents } from "./pricing.ts";\n\nexport function checkoutTotal(total: number): number {\n  return roundCents(applyDiscount(total, 0.15));\n}\n',
    );
    const head = commit("raise the discount");
    // The worker's child, with settings that take leads from Graph, in a home of its own. HOME is
    // part of the engine's fixed environment, so the child's searches reach a Graph service of
    // their own here; a user's real processes share one HOME and so one service.
    const home = join(directory, "home");
    // The settings file's place depends on the platform (Library/Application Support on macOS).
    mkdirSync(dirname(settingsPath(home)), { recursive: true });
    writeFileSync(
      settingsPath(home),
      JSON.stringify({
        version: 1,
        search: { graph: { executable: engine }, leads: "graph" },
      }),
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        cli,
        ...prepareCommitArgs(repository, {
          oid: head,
          parents: [base],
          tree: run("rev-parse", `${head}^{tree}`),
        }),
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain("graph leads 1 searched, 0 reused");
    const location = await Effect.runPromise(resolveStoreLocation(repository));
    // Lead searches use the commit clone. Relations also prepare the review clone.
    expect(
      existsSync(join(location.directory, COMMIT_GRAPH_DIRECTORY, "clones")),
    ).toBe(true);
    expect(
      existsSync(join(location.directory, COMMIT_GRAPH_DIRECTORY, "cache")),
    ).toBe(false);
    const runtime = {
      executable: engine,
      workDirectory: join(location.directory, "graph"),
    };
    expect(existsSync(join(runtime.workDirectory, "clones"))).toBe(true);
    expect(existsSync(join(runtime.workDirectory, "cache"))).toBe(true);
    setSearchRuntime({ graph: runtime, frozen: new Map(), problems: {} });
    const records: Array<RunLogRecord> = [];
    const log = {
      path: "",
      write: (record: RunLogRecord) => {
        records.push(JSON.parse(JSON.stringify(record)) as RunLogRecord);
      },
      read: () => records,
    };
    const registry: Metric.MetricRegistry = new Map();
    const { leads, searched } = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* graphConfigFor(runtime);
        const prepared = yield* rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          { ...defaultManifestSettings(1_000_000), retriever: config },
          captureOutlineSource(),
        );
        const manifest = prepared.value;
        const leads = prepared.leads.value;
        const lookedUp = spansNamed(records, "harness.retriever.search").length;
        // Then one search as an agent's graph_search makes it, over the range's base.
        const { retriever } = yield* retrieverFor(
          {
            repository,
            source: captureOutlineSource(),
            tree: manifest.range.baseTree,
            commit: base,
          },
          config,
        );
        yield* retriever.search({
          text: "where is the discount applied to the total",
          sha256: "0".repeat(64),
          limit: 5,
        });
        return { leads, searched: lookedUp };
      }).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
        Effect.provideService(Tracer.Tracer, runLogTracer(log)),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    );
    writeMetrics(log, registry);
    // The review found the child's lead ready and searched nothing for it.
    expect(searched).toBe(0);
    expect(leads.hunks.every((hunk) => hunk.leads?.source === "cached")).toBe(
      true,
    );
    const metrics = records.filter((record) => record.type === "metric");
    expect(
      metrics
        .filter((record) => record["name"] === "harness.leads.hunks")
        .map((record) => record["attributes"]),
    ).toEqual([
      { "harness.leads.source": "ready", "harness.retriever": "graph" },
    ]);
    // The agent's search: how it got its answer, and, on the search's own work beneath it,
    // Graph's own timings, the child's CPU and the two waits.
    const searches = spansNamed(records, "harness.retriever.search");
    expect(searches).toHaveLength(1);
    expect(searches[0]!["attributes"]).toMatchObject({
      "harness.retriever": "graph",
      "harness.graph.answer": "computed",
    });
    const works = spansNamed(records, GRAPH_SEARCH_SPAN);
    expect(works).toHaveLength(1);
    const search = works[0]!;
    expect(search["parentSpanId"]).toBe(searches[0]!["spanId"]);
    const attributes = search["attributes"] as Record<string, unknown>;
    expect(attributes).toMatchObject({ "harness.graph.index_cache": "hit" });
    for (const key of [
      "harness.graph.preselect_latency_ms",
      "harness.graph.query_latency_ms",
      "harness.graph.total_latency_ms",
      "harness.graph.wall_ms",
      "harness.graph.cpu.user_ms",
      "harness.graph.cpu.system_ms",
      "harness.graph.commands",
    ])
      expect(typeof attributes[key]).toBe("number");
    expect(Number(attributes["harness.graph.cpu.user_ms"])).toBeGreaterThan(0);
    // The agent's search waits a bounded time, so it asks the service's queue as interactive with
    // that wait; the service, when it answered, says which class it ran in and how long it queued.
    expect(attributes["harness.graph.queue.class"]).toBe("interactive");
    expect(
      Number(attributes["harness.graph.queue.deadline_ms"]),
    ).toBeGreaterThan(0);
    if (attributes["harness.graph.service.answered"] === true) {
      expect(attributes["harness.graph.service.class"]).toBe("interactive");
      expect(typeof attributes["harness.graph.service.queue_wait_ms"]).toBe(
        "number",
      );
    }
    expect(
      (search["events"] as Array<{ name: string }>).map((event) => event.name),
    ).toEqual([GRAPH_EVENTS.baseReady, GRAPH_EVENTS.slotTaken]);
    const metric = (name: string) =>
      metrics.filter((record) => record["name"] === name);
    expect(metric("harness.graph.search.duration")).toHaveLength(1);
    expect(metric("harness.graph.search.cpu")).toHaveLength(1);
    // One search alone: the time Graph was busy is that search's time.
    expect(metric("harness.graph.busy.duration")).toHaveLength(1);
  },
  300_000,
);
