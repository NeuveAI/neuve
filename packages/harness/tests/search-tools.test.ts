import { indexRecipe } from "../src/search-index.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: 10.89 gives Investigate Graph's semantic query and E0 as search tools, and the end-to-end
// check reads what each finds from the results agents saw and the lineage they recorded. These
// tests hold the boundaries that check depends on, without a model, a Graph engine or Python:
// - semantic_search ranks the stored benchmark vectors, names its retriever on every result and
//   handle, pages under 10.18's 3,000-token cap, and discloses chunks it could not search;
// - a search that cannot answer is a disclosed gap (never an empty result), is logged, and is
//   answered the same way when its call runs again, while a later turn asks again;
// - a frozen candidate's leads are served under the candidate's name and its file's hash in the
//   leads key, a hunk with no row gets BM25's leads named as BM25's, and a changed file is refused;
// - an E0 answer is keyed on which chunks have vectors, so one that left chunks unsearched is not
//   reused once the vector store has them;
// - a frozen row whose regions are all outside the base falls back to BM25 with a note, and an
//   overlapping row serves at most one hunk.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  BUDGET_LINE_BYTES,
  TOOL_RESULT_TOKENS,
  estimateTokens,
} from "../src/budget.ts";
import { benchChunkSpec, E0_DIMENSIONS } from "../src/e0.ts";
import { assignRows, frozenKeyed, type FrozenRow } from "../src/frozen.ts";
import { cachedLeads, leadsSpec } from "../src/leads.ts";
import * as L from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import {
  DEFAULT_RETRIEVER,
  type FrozenConfig,
  type GraphConfig,
  type SearchResult,
} from "../src/retriever.ts";
import {
  E0_RETRIEVER,
  setSearchRuntime,
  type SearchConfig,
} from "../src/search-config.ts";
import { treeIndex } from "../src/search-index.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-search-"));
afterAll(() => {
  setSearchRuntime({ frozen: new Map(), problems: {} });
  rmSync(directory, { recursive: true, force: true });
});
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
const commit = (message: string) => {
  git("add", ".");
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

const dense = "ŝtrïng ✓ ünïcödé ".repeat(8);
let base = "";
let head = "";
beforeAll(() => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  mkdirSync(join(repository, "src"), { recursive: true });
  for (let i = 0; i < 40; i++)
    writeFileSync(
      join(repository, "src", `widget-${i}.ts`),
      `export function widget${i}(input: string): string {\n  return input + "${dense}${i}";\n}\n`,
    );
  writeFileSync(join(repository, "main.ts"), "export const main = 1;\n");
  base = commit("base");
  writeFileSync(
    join(repository, "main.ts"),
    'import { widget1 } from "./src/widget-1.ts";\nexport const main = widget1("x");\n',
  );
  writeFileSync(
    join(repository, "src", "widget-2.ts"),
    `export function widget2(input: string): string {\n  return input.trim();\n}\n`,
  );
  writeFileSync(
    join(repository, "src", "widget-3.ts"),
    `export function widget3(input: string): string {\n  return input.toUpperCase();\n}\n`,
  );
  writeFileSync(
    join(repository, "src", "widget-5.ts"),
    `export function widget5(input: string): string {\n  return input.toLowerCase();\n}\n`,
  );
  head = commit("change");
});

/** A deterministic unit vector per seed. */
const unit = (seed: string) => {
  const values = new Float32Array(E0_DIMENSIONS);
  let state = createHash("sha256").update(seed).digest();
  for (let at = 0; at < E0_DIMENSIONS; at++) {
    if (at % 32 === 0)
      state = createHash("sha256").update(state).update(String(at)).digest();
    values[at] = (state[at % 32]! - 127.5) / 127.5;
  }
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
};

const storeLayer = (location: ReturnType<typeof storeLocationIn>) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );

/** The range's lookup context over a store, with the given search config and attempt. */
const lookups = (
  search: SearchConfig | undefined,
  onGap?: (detail: string) => void,
) =>
  Effect.gen(function* () {
    const location = storeLocationIn(join(directory, "store"));
    const manifest = (yield* rangeManifest(
      repository,
      { baseOid: base, headOid: head },
      defaultManifestSettings(1_000_000),
      captureOutlineSource(),
    )).value;
    const views = yield* L.revisionViews(repository, manifest);
    const records = yield* Effect.context<
      Blobs.BlobStore | Computations.ComputationStore
    >();
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
      search,
      attempt: { runId: "run-1", agent: "investigate.p1" },
      onGap,
    };
    return ctx;
  });

const runIn = <A>(
  name: string,
  effect: Effect.Effect<
    A,
    unknown,
    Blobs.BlobStore | Computations.ComputationStore
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(storeLayer(storeLocationIn(join(directory, name)))),
    ),
  );

const capped = (text: string) =>
  estimateTokens(Buffer.byteLength(text) + BUDGET_LINE_BYTES) <=
  TOOL_RESULT_TOKENS;

test("semantic_search ranks the stored vectors, names E0 everywhere, pages under the cap and discloses chunks it could not search", async () => {
  const vectors = join(directory, "vectors");
  const query = "where is the widget input trimmed";
  // The benchmark's vectors for every chunk but the first two, in their own store (written in a
  // run of their own: a layer provided inside another run would reuse the outer run's store).
  const writeVectors = (pick: (count: number) => [number, number]) =>
    runIn(
      "vectors",
      Effect.gen(function* () {
        const tree = git("rev-parse", `${base}^{tree}`);
        const { index } = yield* treeIndex(
          repository,
          tree,
          captureOutlineSource(),
        );
        const store = yield* Computations.ComputationStore;
        for (const chunk of index.chunks.slice(...pick(index.chunks.length)))
          yield* store.run(
            benchChunkSpec(chunk.textSha256, chunk.path),
            Effect.succeed({
              bytes: new Uint8Array(unit(chunk.textSha256).buffer),
              mediaType: "application/octet-stream",
            }),
          );
      }),
    );
  await writeVectors((count) => [2, count]);
  const result = await runIn(
    "store",
    Effect.gen(function* () {
      const tree = git("rev-parse", `${base}^{tree}`);
      const { index } = yield* treeIndex(
        repository,
        tree,
        captureOutlineSource(),
      );
      const target = index.chunks.find(
        (chunk) => chunk.path === "src/widget-7.ts",
      )!;
      // The query's vector is already stored in the run's store, so no encoder runs.
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        {
          op: "harness.e0-query",
          opVersion: 2,
          inputs: {
            query: createHash("sha256").update(query).digest("hex"),
          },
          config: { model: E0_RETRIEVER.model, queries: E0_RETRIEVER.queries },
        },
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({
              values: [...unit(target.textSha256)],
              cut: [],
              keptCharacters: query.length,
            }),
          ),
          mediaType: "application/json",
        }),
      );
      setSearchRuntime({
        e0: {
          python: "/nonexistent/python",
          snapshot: "/nonexistent/snapshot",
          worker: "/nonexistent/worker.py",
          vectorStore: vectors,
        },
        frozen: new Map(),
        problems: {},
      });
      const search: SearchConfig = {
        graph: null,
        e0: E0_RETRIEVER,
        graphDeadlineMs: 45_000,
      };
      const ctx = yield* lookups(search);
      const tool = L.semanticSearchTool(ctx, E0_RETRIEVER, {
        withVectors: index.chunks.length - 2,
        chunks: index.chunks.length,
      });
      const first = yield* tool.handle({ query, k: 10 });
      const again = yield* tool.handle({ query, k: 10 });
      // The store gains the two missing vectors: the same query is answered anew, over them all.
      yield* Effect.promise(() => writeVectors(() => [0, 2]));
      const refreshed = yield* tool.handle({ query, k: 10 });
      const ids = [...first.text.matchAll(/ (h[0-9a-f]{9}) /g)].map(
        (m) => m[1]!,
      );
      return {
        first,
        again,
        refreshed,
        target: `src/widget-7.ts:${target.startLine}-${target.endLine}`,
        handles: ids.map((id) => ctx.handles.get(id)!),
        chunks: index.chunks.length,
      };
    }),
  );
  expect(result.first.error).toBeUndefined();
  expect(capped(result.first.text)).toBe(true);
  expect(result.first.text).toContain(`1. `);
  expect(result.first.text).toMatch(
    new RegExp(
      `1\\. h[0-9a-f]{9} ${result.target.replace(/[.]/g, "\\.")} @base`,
    ),
  );
  expect(result.first.text).toContain(
    `Not searched: 2 of ${result.chunks} chunks have no stored E0 vector and were not searched.`,
  );
  // Every result line names E0, and every handle records the tool and the retriever.
  const lines = result.first.text
    .split("\n")
    .filter((line) => /^\d+\. h/.test(line));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toContain("· via e0, score");
  for (const handle of result.handles) {
    expect(handle.lookup).toBe("semantic_search");
    expect(handle.retrieval?.retriever).toBe("e0");
  }
  // The same call answers the same, but for what depends on the run's other calls: how many
  // queries returned a chunk, and the data tags that hash the body holding those counts. A read
  // pi runs again after a crash answers the model as before (pi/stages/tools.ts).
  const withoutRunCounts = (text: string) =>
    text
      .replace(/<(\/?)data-[0-9a-f]+\b/g, "<$1data")
      .replace(/ · returned for \d+ quer(?:y|ies) this run/g, "")
      .replace(/ \(this query was already answered in this run\)/g, "");
  expect(withoutRunCounts(result.again.text)).toBe(
    withoutRunCounts(result.first.text),
  );
  expect(result.refreshed.text).not.toContain("Not searched");
  expect(result.refreshed.text).not.toContain(
    "this query was already answered",
  );
}, 120_000);

test("a search that cannot answer is a disclosed gap, logged, and replayed as the model saw it", async () => {
  const graph: GraphConfig = {
    id: "graph",
    engine: {
      sha256: "a".repeat(64),
      provider: "entire-graph",
      version: "dev",
      identityRevision: "4",
    },
    profile: "full",
    topK: 50,
  };
  const search: SearchConfig = {
    graph,
    e0: null,
    graphDeadlineMs: 45_000,
  };
  const gaps: Array<string> = [];
  const result = await runIn(
    "gap-store",
    Effect.gen(function* () {
      setSearchRuntime({
        frozen: new Map(),
        problems: { graph_search: "no Graph engine at /first" },
      });
      const ctx = yield* lookups(search, (detail) => gaps.push(detail));
      const tool = L.graphSearchTool(ctx, graph);
      ctx.handles.turn = 3;
      const first = yield* tool.handle({ query: "where are widgets trimmed" });
      // The machine changes; a replay of turn 3 still answers as the model saw it.
      setSearchRuntime({
        frozen: new Map(),
        problems: { graph_search: "no Graph engine at /second" },
      });
      const replayed = yield* tool.handle({
        query: "where are widgets trimmed",
      });
      ctx.handles.turn = 4;
      const later = yield* tool.handle({ query: "where are widgets trimmed" });
      return { first, replayed, later };
    }),
  );
  expect(result.first.error).toBe("SearchUnavailable");
  expect(result.first.empty).toBeUndefined();
  expect(result.first.text).toContain("no Graph engine at /first");
  expect(result.first.text).toContain(
    "This is a gap, not an empty result: nothing was searched.",
  );
  expect(result.replayed.text).toBe(result.first.text);
  expect(result.later.text).toContain("no Graph engine at /second");
  expect(gaps).toEqual([
    "graph_search: no Graph engine at /first",
    "graph_search: no Graph engine at /second",
  ]);
}, 120_000);

test("a frozen candidate's leads, from the labelling side's all-hunks rows (no hunk ID, matched by diff text, else spans), carry its name and file hash; an unmatched hunk gets BM25's; a changed file is refused", async () => {
  const result = await runIn(
    "frozen-store",
    Effect.gen(function* () {
      const plain = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      )).value;
      const main = plain.hunks.find((hunk) => hunk.path === "main.ts")!;
      const other = plain.hunks.find(
        (hunk) => hunk.path === "src/widget-2.ts",
      )!;
      const spanned = plain.hunks.find(
        (hunk) => hunk.path === "src/widget-3.ts",
      )!;
      const gone = plain.hunks.find((hunk) => hunk.path === "src/widget-5.ts")!;
      const caseId = `repo:${base.slice(0, 8)}..${head.slice(0, 8)}`;
      // The rows as the labelling side's all-hunks mode writes them: no hunk ID.
      const rows = [
        {
          caseId,
          path: main.path,
          oldPath: main.oldPath,
          old: { start: main.oldStart, lines: main.oldLines },
          new: { start: main.newStart, lines: main.newLines },
          diffText: main.text.replace(/\n$/, ""),
          queryText: "path: main.ts",
          graph: { status: "answered" },
          regions: [
            ["src/widget-1.ts", 1, 3, "src/widget-1.ts#L1-L3", "code", 40, 0.9],
            ["gone.ts", 1, 2, "gone.ts#L1-L2", "code", 10, 0.8],
            ["src/widget-9.ts", 1, 3, "src/widget-9.ts#L1-L3", "code", 40, 0.7],
          ],
        },
        {
          // No diff text: matched by its spans.
          caseId,
          path: spanned.path,
          oldPath: spanned.oldPath,
          old: { start: spanned.oldStart, lines: spanned.oldLines },
          new: { start: spanned.newStart, lines: spanned.newLines },
          queryText: "path: src/widget-3.ts",
          graph: { status: "timeout" },
          regions: [
            ["src/widget-4.ts", 1, 3, "src/widget-4.ts#L1-L3", "code", 40, 0.5],
          ],
        },
        {
          // Every region outside the base tree.
          caseId,
          path: gone.path,
          oldPath: gone.oldPath,
          old: { start: gone.oldStart, lines: gone.oldLines },
          new: { start: gone.newStart, lines: gone.newLines },
          diffText: gone.text,
          regions: [["gone.ts", 1, 2, "gone.ts#L1-L2", "code", 10, 0.4]],
        },
      ];
      const file = join(directory, "R(H3-E0).jsonl.gz");
      const bytes = gzipSync(
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      writeFileSync(file, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const frozen: FrozenConfig = {
        id: "frozen",
        candidate: "R(H3-E0)",
        sha256,
        fallback: DEFAULT_RETRIEVER,
      };
      setSearchRuntime({ frozen: new Map([[sha256, file]]), problems: {} });
      const settings = {
        ...defaultManifestSettings(1_000_000),
        retriever: frozen,
      };
      // The range's leads, which hold each hunk's.
      const manifest = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        settings,
        captureOutlineSource(),
      )).leads.value;
      const changed = yield* Effect.result(
        rangeManifest(
          repository,
          { baseOid: base, headOid: head },
          {
            ...settings,
            retriever: { ...frozen, sha256: "b".repeat(64) },
          },
          captureOutlineSource(),
        ),
      );
      return {
        main: manifest.hunks.find((hunk) => hunk.hunkId === main.hunkId)!,
        other: manifest.hunks.find((hunk) => hunk.hunkId === other.hunkId)!,
        spanned: manifest.hunks.find((hunk) => hunk.hunkId === spanned.hunkId)!,
        gone: manifest.hunks.find((hunk) => hunk.hunkId === gone.hunkId)!,
        // The leads were stored under the candidate's key with the range, not BM25's or another range's.
        storedUnderRange: (yield* cachedLeads(
          main,
          frozen,
          indexRecipe(captureOutlineSource()),
          frozenKeyed({ mergeBase: base, headOid: head }),
        ))._tag,
        storedWithoutRange: (yield* cachedLeads(
          main,
          frozen,
          indexRecipe(captureOutlineSource()),
        ))._tag,
        keys: {
          frozen: Computations.computationKey(
            leadsSpec(main, frozen, indexRecipe(captureOutlineSource())),
          ).key,
          bm25: Computations.computationKey(
            leadsSpec(
              main,
              DEFAULT_RETRIEVER,
              indexRecipe(captureOutlineSource()),
            ),
          ).key,
        },
        changed,
      };
    }),
  );
  const regions = (results: ReadonlyArray<SearchResult>) =>
    results.map(
      (entry) =>
        `${entry.identity.path}:${entry.identity.startLine}-${entry.identity.endLine} ${entry.retrieval.retriever} #${entry.retrieval.rank}`,
    );
  // The file's ranking, in order, under the candidate's name; a region not in the base is skipped.
  expect(regions(result.main.leads!.results)).toEqual([
    "src/widget-1.ts:1-3 R(H3-E0) #1",
    "src/widget-9.ts:1-3 R(H3-E0) #2",
  ]);
  expect(result.main.leads!.results[0]!.retrieval.score).toBe(0.9);
  expect(result.main.leads!.note).toBe(
    "1 region(s) of R(H3-E0)'s row were not in the base tree and were skipped",
  );
  // A row with no region in the base tree: BM25's leads, named as BM25's, and a note saying why.
  expect(result.gone.leads!.results.length).toBeGreaterThan(0);
  for (const entry of result.gone.leads!.results)
    expect(entry.retrieval.retriever).toBe("bm25");
  expect(result.gone.leads!.note).toBe(
    "none of the 1 region(s) in R(H3-E0)'s row for this hunk is in the base tree; these are bm25's leads",
  );
  expect(result.storedUnderRange).toBe("Some");
  expect(result.storedWithoutRange).toBe("None");
  expect(regions(result.spanned.leads!.results)).toEqual([
    "src/widget-4.ts:1-3 R(H3-E0) #1",
  ]);
  // A hunk the file has no row for: BM25's leads, named as BM25's.
  expect(result.other.leads!.results.length).toBeGreaterThan(0);
  for (const entry of result.other.leads!.results)
    expect(entry.retrieval.retriever).toBe("bm25");
  expect(result.other.leads!.note).toBe(
    "R(H3-E0)'s leads file has no row for this hunk; these are bm25's leads",
  );
  expect(result.keys.frozen).not.toBe(result.keys.bm25);
  expect(result.changed._tag).toBe("Failure");
  expect(String((result.changed as { failure: unknown }).failure)).toContain(
    "no frozen leads file with SHA-256 bbbbbbbbbbbb",
  );
}, 120_000);

test("an overlapping row serves at most one hunk, and never one another hunk matches exactly", () => {
  const hunk = (
    hunkId: string,
    newStart: number,
    newLines: number,
    text: string,
  ) => ({
    hunkId,
    path: "a.ts",
    kind: "text" as const,
    oldStart: newStart,
    oldLines: newLines,
    newStart,
    newLines,
    text,
  });
  const row = (start: number, lines: number, diffText?: string): FrozenRow => ({
    caseId: "repo:aaaaaaa..bbbbbbb",
    path: "a.ts",
    old: { start, lines },
    new: { start, lines },
    ...(diffText === undefined ? {} : { diffText }),
    regions: [],
  });
  const exact = row(10, 5, "@@ b @@");
  const shared = row(30, 10);
  const assigned = assignRows(
    [
      hunk("ha", 8, 6, "@@ a @@"), // overlaps `exact`, which hb matches by text
      hunk("hb", 10, 5, "@@ b @@"),
      hunk("hc", 31, 2, "@@ c @@"), // both hc and hd overlap `shared`
      hunk("hd", 35, 2, "@@ d @@"),
    ],
    [exact, shared],
  );
  expect(assigned.get("hb")).toEqual({ row: exact, how: "text" });
  expect(assigned.get("ha")).toBeUndefined();
  expect(assigned.get("hc")).toEqual({ row: shared, how: "overlap" });
  expect(assigned.get("hd")).toBeUndefined();
});
