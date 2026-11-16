// Why: 10.119 keeps keyword leads the default while the lanes climb runs, and a review that asks
// for hybrid leads on a machine that cannot serve them must be refused, not given keyword leads
// under the hybrid name. Hybrid preparation stays off unless the settings turn it on, so no model
// work runs at commit time by accident.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { DEFAULT_RETRIEVER } from "../src/retriever.ts";
import { resolveSearch, searchRuntimeFrom } from "../src/search-config.ts";
import { Settings } from "../src/settings.ts";

/** The real reranker worker: the one file whose SHA-256 this build accepts. */
const RERANKER = new URL(
  "../../semantic-client/src/reranker_worker.py",
  import.meta.url,
).pathname;

const settings = (search: unknown) =>
  Option.some(Settings.parse({ version: 1, search }));

test("keyword leads stay the default, and hybrid leads are refused where they are not set up", async () => {
  const none = Option.none<Settings>();
  const runtime = searchRuntimeFrom(none, "/store");
  expect((await Effect.runPromise(resolveSearch(runtime, none))).leads).toEqual(
    DEFAULT_RETRIEVER,
  );
  const refused = await Effect.runPromise(
    Effect.flip(resolveSearch(runtime, none, "hybrid")),
  );
  expect(String(refused)).toContain("hybrid leads are not set up");
  // Hybrid named with a relative path, or without a Graph engine: a problem, not a runtime.
  const relative = settings({
    hybrid: {
      device: "cpu",
      python: "venv/bin/python",
      e0: { snapshot: "/e0" },
      reranker: { snapshot: "/r", worker: RERANKER },
      graph: { executable: "/bin/sh" },
    },
  });
  const relativeRuntime = searchRuntimeFrom(relative, "/store");
  expect(relativeRuntime.hybrid).toBeUndefined();
  expect(relativeRuntime.problems["hybrid"]).toContain("absolute paths");
  expect(
    String(
      await Effect.runPromise(
        Effect.flip(resolveSearch(relativeRuntime, relative, "hybrid")),
      ),
    ),
  ).toContain("absolute paths");
  const noGraph = searchRuntimeFrom(
    settings({
      hybrid: {
        device: "cpu",
        python: "/p",
        e0: { snapshot: "/e0", worker: "/w0.py" },
        reranker: { snapshot: "/r", worker: RERANKER },
        graph: { executable: "/nowhere/entire-graph" },
      },
    }),
    "/store",
  );
  expect(noGraph.problems["hybrid"]).toContain("no Graph engine");
  // A reranker worker that is not this build's is refused, wherever it is.
  const changed = join(mkdtempSync(join(tmpdir(), "hybrid-worker-")), "w.py");
  writeFileSync(changed, "print('not the reranker')\n");
  const foreign = searchRuntimeFrom(
    settings({
      hybrid: {
        device: "cpu",
        python: "/p",
        e0: { snapshot: "/e0", worker: "/w0.py" },
        reranker: { snapshot: "/r", worker: changed },
        graph: { executable: "/bin/sh" },
      },
    }),
    "/store",
  );
  expect(foreign.problems["hybrid"]).toContain(
    "not the one this build expects",
  );
});

// Why: hybrid's settings must not change reviews that do not ask for it. If setting hybrid up gave
// every review's agents E0 and Graph search, the lanes climb's runs would change under it.
test("setting hybrid up gives reviews no search tools and keeps keyword leads", async () => {
  const configured = settings({
    hybrid: {
      device: "mps",
      python: "/p",
      e0: { snapshot: "/e0" },
      reranker: { snapshot: "/r" },
      graph: { executable: "/bin/sh" },
    },
  });
  const runtime = searchRuntimeFrom(configured, "/store");
  expect(runtime.problems["hybrid"]).toBeUndefined();
  expect(runtime.hybrid?.device).toBe("mps");
  expect(runtime.e0).toBeUndefined();
  expect(runtime.graph).toBeUndefined();
  const resolved = await Effect.runPromise(resolveSearch(runtime, configured));
  expect(resolved.search).toBeUndefined();
  expect(resolved.leads).toEqual(DEFAULT_RETRIEVER);
});

test("hybrid preparation is off unless the settings turn it on", () => {
  const parsed = Settings.parse({
    version: 1,
    search: {
      hybrid: {
        device: "mps",
        python: "/p",
        e0: { snapshot: "/e0" },
        reranker: { snapshot: "/r" },
      },
    },
  });
  expect(parsed.search?.hybrid?.prepare).toBeUndefined();
  expect(() =>
    Settings.parse({
      version: 1,
      search: {
        hybrid: {
          device: "gpu",
          python: "/p",
          e0: { snapshot: "/e0" },
          reranker: { snapshot: "/r" },
        },
      },
    }),
  ).toThrow();
});
