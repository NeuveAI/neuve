import { indexRecipe } from "../src/search-index.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: a review never waits on Graph past its wait (architecture record 0013). Past it, a hunk's
// Graph leads become the keyword search's, said so in the leads' note and counted as a fallback,
// and an agent's graph_search answers that Graph is still working; neither cuts Graph off, so its
// leads are stored and a later ask returns its answer. Wrong here, a review would either wait on
// Graph again or silently lose Graph's work, and only the fallback count would hint at it. This
// runs the real engine (a first search on a fresh base takes far longer than the 1 ms wait set
// here), over a small repository, and checks the leads, the stored Graph leads, the agent's two
// answers and the counts. It runs only where the engine is built (`bun run build:graph`).
import { afterAll, expect, test } from "bun:test";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Layer, Metric, Option, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { GRAPH_EVENTS, GRAPH_SEARCH_SPAN } from "../src/graph-search.ts";
import { cachedLeads } from "../src/leads.ts";
import * as L from "../src/lookups.ts";
import {
  defaultManifestSettings,
  leadsByHunk,
  rangeManifest,
} from "../src/manifest.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { graphConfigFor, setSearchRuntime } from "../src/search-config.ts";
import { withAttemptMetrics, writeMetrics } from "../src/telemetry.ts";
import { capResult } from "../src/toolkit.ts";

const engine = resolve(
  import.meta.dir,
  "../../../apps/neuve-graph/entire-graph",
);
const directory = mkdtempSync(join(tmpdir(), "harness-graph-fallback-"));
/** The span of one graph_search call this test makes as the agent (the run log keeps `harness.`). */
const ASK_SPAN = "harness.test.ask";
afterAll(() => {
  setSearchRuntime({ frozen: new Map(), problems: {} });
  rmSync(directory, { recursive: true, force: true });
});

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
  "past the review's wait, Graph's leads and answers fall back, disclosed and counted, while Graph finishes and keeps them",
  async () => {
    graphPrerequisite.require();
    Bun.spawnSync(["git", "init", "-q", repository]);
    const pricing = (rate: string) =>
      `export function applyDiscount(total: number, rate: number): number {\n  return total - total * rate;\n}\n\nexport const defaultRate = ${rate};\n`;
    const checkout = (cents: string) =>
      `import { applyDiscount, defaultRate } from "./pricing.ts";\n\nexport function checkoutTotal(total: number): number {\n  return Math.round(applyDiscount(total, defaultRate) * ${cents}) / ${cents};\n}\n`;
    // Six changed files, so the round's Graph searches queue for the one slot behind each other.
    const extras = ["tax", "shipping", "coupon", "invoice"];
    const extra = (name: string, value: string) =>
      `export function ${name}Amount(total: number): number {
  return total * ${value};
}
`;
    writeFileSync(join(repository, "pricing.ts"), pricing("0.1"));
    writeFileSync(join(repository, "checkout.ts"), checkout("100"));
    for (const name of extras)
      writeFileSync(join(repository, `${name}.ts`), extra(name, "0.2"));
    const base = commit("base");
    writeFileSync(join(repository, "pricing.ts"), pricing("0.15"));
    writeFileSync(join(repository, "checkout.ts"), checkout("1000"));
    for (const name of extras)
      writeFileSync(join(repository, `${name}.ts`), extra(name, "0.25"));
    const head = commit("raise the rates, round finer");
    const runtime = {
      executable: engine,
      workDirectory: join(directory, "store", "graph"),
    };
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
    const location = storeLocationIn(join(directory, "store"));
    const poll = <A>(
      check: Effect.Effect<A | undefined, unknown, never>,
      label: string,
    ) =>
      Effect.gen(function* () {
        for (let at = 0; at < 240; at++) {
          const value = yield* check;
          if (value !== undefined) return value;
          yield* Effect.sleep("500 millis");
        }
        return yield* Effect.die(new Error(`${label} never arrived`));
      });
    const attemptRegistry: Metric.MetricRegistry = new Map();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Store.prepareForWrite;
        const config = yield* graphConfigFor(runtime);
        // The review's attempt: the manifest and two agent asks. It ends, and its metrics are
        // written, while the round's Graph searches still run.
        const { manifest, leads, records, waited, ask, first } =
          yield* Effect.gen(function* () {
            const prepared = yield* rangeManifest(
              repository,
              { baseOid: base, headOid: head },
              {
                ...defaultManifestSettings(1_000_000),
                retriever: config,
                graphWaitMs: 1,
              },
              captureOutlineSource(),
            );
            const manifest = prepared.value;
            const leads = leadsByHunk(prepared.leads.value);
            const records = yield* Effect.context<
              Blobs.BlobStore | Computations.ComputationStore
            >();
            // An agent's graph_search with the same 1 ms wait: first still working, then answered.
            const views = yield* L.revisionViews(repository, manifest);
            const ctx: L.LookupContext = {
              source: captureOutlineSource(),
              repository,
              location,
              cycleId: "cycle",
              manifest,
              head: views.head,
              base: views.base,
              hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
              commits: yield* L.rangeCommits(repository, manifest),
              snapshot: undefined,
              records,
              handles: new L.HandleRegistry(),
              searchFrequency: new Map(),
              search: { graph: config, e0: null, graphDeadlineMs: 1 },
            };
            const asker = (wait: number) =>
              Effect.gen(function* () {
                const tool = L.graphSearchTool(
                  {
                    ...ctx,
                    search: { ...ctx.search!, graphDeadlineMs: wait },
                  },
                  config,
                );
                // Each ask is a call in a span of its own, numbered, so the Graph searches under it
                // can be counted against the asks this test made.
                return (query: string) => {
                  let calls = 0;
                  return Effect.gen(function* () {
                    yield* Effect.annotateCurrentSpan({
                      "harness.test.wait_ms": wait,
                      "harness.test.call": ++calls,
                    });
                    const outcome = yield* tool.handle(
                      tool.input?.parse({ query }),
                    );
                    return capResult(outcome.text, undefined);
                  }).pipe(Effect.withSpan(ASK_SPAN));
                };
              });
            // An agent that waits as a review's agent does, asking while the round's searches still
            // queue: it is answered ahead of them.
            const waited = yield* (yield* asker(120_000))(
              "which function applies the discount",
            );
            const ask = (yield* asker(1))(
              "where is the checkout total rounded",
            );
            // An agent with a 1 ms wait: still working first, then answered.
            const first = yield* ask;
            return { manifest, leads, records, waited, ask, first };
          }).pipe(withAttemptMetrics(log, attemptRegistry));
        // Graph's leads, stored after the review stopped waiting for them.
        const graphLeads = yield* Effect.forEach(manifest.hunks, (hunk) =>
          poll(
            Effect.map(
              cachedLeads(
                hunk,
                config,
                indexRecipe(captureOutlineSource()),
              ).pipe(Effect.provide(records)),
              Option.getOrUndefined,
            ),
            `Graph's leads for ${hunk.path}`,
          ),
        );
        const later = yield* poll(
          Effect.map(Effect.orDie(ask), (text) =>
            text.includes("has not answered") ? undefined : text,
          ),
          "Graph's answer to the agent",
        );
        return { manifest, leads, graphLeads, waited, first, later };
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
    // Every hunk went on with the keyword search's leads, and says so.
    expect(outcome.manifest.hunks.length).toBe(6);
    for (const hunk of outcome.manifest.hunks) {
      const leads = outcome.leads.get(hunk.hunkId);
      expect(leads?.note).toContain("the keyword search's");
      expect(
        leads?.results.every((result) => result.retrieval.retriever === "bm25"),
      ).toBe(true);
    }
    // Graph kept going: its own leads were stored.
    for (const leads of outcome.graphLeads)
      expect(
        leads.results.every((result) => result.retrieval.retriever === "graph"),
      ).toBe(true);
    expect(outcome.waited).toContain("result(s) at base");
    expect(outcome.first).toContain("graph_search has not answered");
    expect(outcome.first).toContain("still working");
    expect(outcome.later).toContain("result(s) at base");
    // The fallback rate's two counts, by caller and reason.
    const metrics = records.filter((record) => record.type === "metric");
    const series = (name: string) =>
      metrics
        .filter((record) => record["name"] === name)
        .map((record) => ({
          attributes: record["attributes"],
          count: (record["state"] as { count?: number }).count,
        }));
    expect(series("harness.graph.fallback")).toContainEqual({
      attributes: {
        "harness.graph.caller": "leads",
        "harness.graph.fallback_reason": "deadline",
      },
      count: 6,
    });
    expect(series("harness.graph.fallback")).toContainEqual(
      expect.objectContaining({
        attributes: {
          "harness.graph.caller": "tool",
          "harness.graph.fallback_reason": "deadline",
        },
      }),
    );
    expect(series("harness.graph.calls")).toContainEqual({
      attributes: { "harness.graph.caller": "leads" },
      count: 6,
    });
    expect(series("harness.leads.hunks")).toContainEqual({
      attributes: {
        "harness.leads.source": "fallback",
        "harness.retriever": "graph",
      },
      count: 6,
    });
    // The Graph searches, by what started them: the round's six lead searches and this test's own
    // ask calls. The service ends the 1 ms agent call at its deadline while keeping the search
    // running and its answer (10.112 and architecture record 0013). The poll above (`later`) asks
    // that question again every 500 ms once the round's leads are stored, long after the service
    // has kept the answer. The engine's client applies the 1 ms deadline to its whole call to the
    // service, from the engine process's start and connecting included (Neuve Graph's
    // `internal/cli/service_unix.go`), so on a loaded machine even a call that would read the kept
    // answer can miss 1 ms and end at the deadline again; a later call reads it. A deadline answer
    // is not kept in this process, so each such call makes one new search; a call made while the
    // previous call's search still runs joins it instead.
    const spans = records.filter((record) => record.type === "span");
    const spansById = new Map(
      spans.map((record) => [record["spanId"], record] as const),
    );
    const searches = spans.filter((span) => span["name"] === GRAPH_SEARCH_SPAN);
    // The lead search or this test's ask call a span ran under: its nearest such ancestor.
    const startedBy = (span: RunLogRecord) => {
      for (
        let parent = spansById.get(span["parentSpanId"]);
        parent !== undefined;
        parent = spansById.get(parent["parentSpanId"])
      )
        if (
          parent["name"] === "harness.leads.search" ||
          parent["name"] === ASK_SPAN
        )
          return parent;
      return undefined;
    };
    const attributesOf = (span: RunLogRecord) =>
      span["attributes"] as Record<string, unknown>;
    // Span starts and durations are whole milliseconds, rounded down, so `endOf` is never later
    // than the true end.
    const startOf = (span: RunLogRecord) => Date.parse(String(span["start"]));
    const endOf = (span: RunLogRecord) =>
      startOf(span) + Number(span["durationMs"]);
    // No Graph search ran outside a lead search or one of this test's ask calls.
    expect(searches.filter((span) => startedBy(span) === undefined)).toEqual(
      [],
    );
    const leadSearches = searches.filter(
      (span) => startedBy(span)?.["name"] === "harness.leads.search",
    );
    expect(leadSearches).toHaveLength(6);
    for (const span of leadSearches) expect(span["status"]).toBe("ok");
    const askCalls = (wait: number) =>
      spans
        .filter(
          (span) =>
            span["name"] === ASK_SPAN &&
            attributesOf(span)["harness.test.wait_ms"] === wait,
        )
        .sort(
          (a, b) =>
            Number(attributesOf(a)["harness.test.call"]) -
            Number(attributesOf(b)["harness.test.call"]),
        );
    const searchesOf = (call: RunLogRecord) =>
      searches.filter((span) => startedBy(span) === call);
    // The waiting agent asked once, and its one search answered within its 120 s wait.
    const waitedCalls = askCalls(120_000);
    expect(waitedCalls).toHaveLength(1);
    const waitedSearches = searchesOf(waitedCalls[0]!);
    expect(waitedSearches).toHaveLength(1);
    expect(waitedSearches[0]!["status"]).toBe("ok");
    expect(
      attributesOf(waitedSearches[0]!)["harness.graph.queue.deadline_ms"],
    ).toBeGreaterThan(1);
    // The 1 ms question's calls, in order: the first ask, then the poll's. Every call but the
    // last made exactly one search, or none when it was made while the previous search still ran
    // (it joined that one); the last read the kept answer and made none.
    const oneMsCalls = askCalls(1);
    expect(
      oneMsCalls.map((call) => attributesOf(call)["harness.test.call"]),
    ).toEqual(oneMsCalls.map((_, at) => at + 1));
    const askSearches: Array<RunLogRecord> = [];
    for (const [at, call] of oneMsCalls.entries()) {
      const made = searchesOf(call);
      const running = askSearches.at(-1);
      if (at === oneMsCalls.length - 1) expect(made).toEqual([]);
      else if (made.length === 0)
        // `endOf` may be up to 2 ms before the true end, so a call made before it ended starts
        // no later than 1 ms past `endOf`.
        expect(
          running !== undefined && startOf(call) <= endOf(running) + 1,
        ).toBe(true);
      else expect(made).toHaveLength(1);
      askSearches.push(...made);
    }
    // The first call's search and every repeat before the answer was read ended at the 1 ms
    // deadline; the last answered. Each started after the one before it ended.
    expect(askSearches.length).toBeGreaterThanOrEqual(2);
    const askDeadlines = askSearches.slice(0, -1);
    for (const span of askDeadlines) {
      const attributes = attributesOf(span);
      expect(span["status"]).toBe("error");
      expect(attributes["harness.graph.service.deadline"]).toBe(true);
      expect(attributes["harness.graph.queue.class"]).toBe("interactive");
      expect(attributes["harness.graph.queue.deadline_ms"]).toBe(1);
      expect(attributes["harness.graph.commands"]).toBeGreaterThan(0);
    }
    expect(askSearches.at(-1)?.["status"]).toBe("ok");
    for (const [at, span] of askSearches.entries())
      if (at > 0)
        expect(startOf(span)).toBeGreaterThanOrEqual(
          endOf(askSearches[at - 1]!),
        );
    const reasks = askDeadlines.length - 1;
    // Every Graph search call's measures were recorded exactly once, whenever it ended: in the
    // attempt's records (which its OTLP copy reads) when it ended within the attempt, in records of
    // their own, written after the attempt's, when it ended later. The same for the round's lead
    // search durations: six lead calls and two answered agent calls, plus the 1 ms ask's deadline
    // call and its deadline re-asks.
    const matches = (
      found: Record<string, unknown> | undefined,
      wanted: Record<string, unknown> | undefined,
    ) =>
      wanted === undefined ||
      Object.entries(wanted).every(([key, value]) => found?.[key] === value);
    const rows = (name: string, attributes?: Record<string, unknown>) =>
      records.flatMap((record, at) =>
        record.type === "metric" &&
        record["name"] === name &&
        matches(record["attributes"] as Record<string, unknown>, attributes)
          ? [{ at, count: (record["state"] as { count: number }).count }]
          : [],
      );
    const total = (found: ReadonlyArray<{ count: number }>) =>
      found.reduce((sum, row) => sum + row.count, 0);
    // What the attempt's own registry held when it wrote its records (and what its OTLP copy reads).
    const inAttempt = (name: string, attributes?: Record<string, unknown>) =>
      Metric.snapshotUnsafe(
        Context.make(
          Metric.MetricRegistry,
          attemptRegistry,
        ) as Context.Context<never>,
      )
        .filter(
          (snapshot) =>
            snapshot.id === name &&
            matches(
              snapshot.attributes as Record<string, unknown> | undefined,
              attributes,
            ),
        )
        .reduce(
          (sum, snapshot) =>
            sum + ((snapshot.state as { count?: number }).count ?? 0),
          0,
        );
    const searchRows = rows("harness.graph.search.duration");
    expect(total(searchRows)).toBe(9 + reasks);
    expect(total(searchRows)).toBe(searches.length);
    expect(total(rows("harness.graph.search.cpu"))).toBe(9 + reasks);
    for (const name of [
      "harness.graph.search.duration",
      "harness.graph.search.cpu",
    ]) {
      expect(total(rows(name, { "harness.status": "answered" }))).toBe(8);
      expect(total(rows(name, { "harness.status": "deadline" }))).toBe(
        1 + reasks,
      );
    }
    const searchesInAttempt = inAttempt("harness.graph.search.duration");
    expect(searchesInAttempt).toBeGreaterThan(0);
    expect(searchesInAttempt).toBeLessThan(8);
    const leadRows = rows("harness.leads.search.duration", {
      "harness.retriever": "graph",
    });
    expect(total(leadRows)).toBe(6);
    expect(
      inAttempt("harness.leads.search.duration", {
        "harness.retriever": "graph",
      }),
    ).toBeLessThan(6);
    // The agent's last ask read the answer Graph kept.
    const answers = records
      .filter(
        (record) =>
          record.type === "span" &&
          record["name"] === "harness.retriever.search",
      )
      .map(
        (span) =>
          (span["attributes"] as Record<string, unknown>)[
            "harness.graph.answer"
          ],
      );
    expect(answers.at(-1)).toBe("ready");
    expect(answers).toContain("pending");
    // Only the 1 ms ask's calls ended at a deadline; a later call read the service's kept answer.
    const deadlines = searches.filter(
      (span) =>
        (span["attributes"] as Record<string, unknown>)[
          "harness.graph.service.deadline"
        ] === true,
    );
    expect(deadlines).toEqual(askDeadlines);
    expect(
      searches.some(
        (span) =>
          (span["attributes"] as Record<string, unknown>)[
            "harness.graph.service.kept_answer"
          ] === true,
      ),
    ).toBe(true);
    // The waiting agent's search took the slot before the round's last searches, which no one
    // waited on any more; none of the round's was cut off (its leads were all stored, above).
    const taken = searches
      .flatMap(
        (span) =>
          span["events"] as Array<{
            name: string;
            at: string;
            attributes?: Record<string, unknown>;
          }>,
      )
      .filter((event) => event.name === GRAPH_EVENTS.slotTaken);
    expect(taken).toHaveLength(9 + reasks);
    const waitedOn = taken.filter(
      (event) => event.attributes?.["harness.graph.waited_on"] === true,
    );
    expect(waitedOn.length).toBeGreaterThanOrEqual(1);
    const lastBackground = taken
      .filter(
        (event) => event.attributes?.["harness.graph.waited_on"] === false,
      )
      .map((event) => Date.parse(event.at))
      .sort((a, b) => a - b)
      .at(-1)!;
    expect(
      Math.min(...waitedOn.map((event) => Date.parse(event.at))),
    ).toBeLessThan(lastBackground);
  },
  300_000,
);
