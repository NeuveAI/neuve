import {
  parseChunker,
  checkBenchmarkWrites,
  refuseCommittedOutput,
} from "./stage-paths.ts";
import { createHash } from "node:crypto";
import { splitLines } from "../../../harness/src/chunker.ts";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Blobs } from "@neuve/records-core";
import { Effect } from "effect";
import { buildIndex, bm25Ranking, BM25 } from "./bm25.ts";
import { chunkId, kindOf, type Occurrence, type Case } from "./corpus.ts";
import { baseView, benchStoreLayer } from "./views.ts";
import { graphChunkVariant } from "./graph-chunk.ts";
import { Manifest } from "./manifest.ts";
import { buildQuery } from "./queries.ts";
import { EncoderProcess, fetchCounter } from "./encoder.ts";
import { loadGold } from "./score/gold.ts";
import { evaluateHunk, familyMean } from "./score/metrics.ts";
import { ALLOWANCES, budgetLabel } from "./score/types.ts";
import { SPLITS, parseSplit, splitCases } from "./split.ts";
import { benchmark, repositories } from "./scoring-inputs.ts";
import type { Ranking, Item } from "./ranking.ts";
import type { GraphOutlineNode, GraphCommandUsage } from "@neuve/graph-client";

/** L-only comparison: no pools, model inference, Graph retrieval or committed outputs. */
const main = async () => {
  const { values } = parseArgs({
    options: {
      chunker: { type: "string" },
      split: { type: "string" },
      executable: { type: "string" },
      output: { type: "string" },
      store: { type: "string" },
      work: { type: "string" },
      python: { type: "string" },
      "head-only": { type: "boolean" },
      "index-only": { type: "boolean" },
      "skip-head": { type: "boolean" },
    },
  });
  const selectedSplits =
    values.split === undefined
      ? Object.values(SPLITS)
      : [parseSplit(values.split)];
  const chunker = parseChunker(values.chunker);
  if (!values.output || !values.store || !values.work)
    throw new Error("--output, --store and --work are required");
  const output = resolve(values.output);
  const work = resolve(values.work);
  checkBenchmarkWrites([output, work, resolve(values.store)]);
  const writeOutput = (path: string, data: string) => {
    refuseCommittedOutput(path);
    return Bun.write(path, data);
  };
  await mkdir(output, { recursive: true });
  await mkdir(work, { recursive: true });
  const usage: GraphCommandUsage[] = [];
  let measuring: "corpus" | "head" | undefined;
  const measured = new Set<string>();
  const outlineLimits: Array<{
    scope: string;
    path: string;
    hash: string;
    tsJs: boolean;
    oversizedNodes: number;
    deepestOversized: Array<{
      startLine: number;
      endLine: number;
      bytes: number;
      reached: boolean;
      windowed: boolean;
    }>;
  }> = [];
  const variant = await graphChunkVariant(
    values.executable ?? "entire-graph",
    work,
    {
      onCommandUsage: (item) => usage.push(item),
    },
    ({ path, text, observation, chunked }) => {
      if (measuring === undefined || !observation?.outline) return;
      const hash = createHash("sha256").update(text).digest("hex");
      const key = `${measuring}\0${path}\0${hash}`;
      if (measured.has(key)) return;
      measured.add(key);
      const row: (typeof outlineLimits)[number] = {
        scope: measuring,
        path,
        hash,
        tsJs: /\.(tsx?|jsx?|[mc][jt]s)$/i.test(path),
        oversizedNodes: 0,
        deepestOversized: [],
      };
      const lines = splitLines(text);
      const visit = (node: GraphOutlineNode, depth: number) => {
        const bytes = Buffer.byteLength(
          lines.slice(node.startLine - 1, node.endLine).join(""),
        );
        if (bytes > 4096) {
          row.oversizedNodes++;
          if (depth === 16)
            row.deepestOversized.push({
              startLine: node.startLine,
              endLine: node.endLine,
              bytes,
              reached: (chunked.outlineLimits ?? []).some(
                (leaf) =>
                  leaf.startLine === node.startLine &&
                  leaf.endLine === node.endLine,
              ),
              windowed: chunked.chunks.some(
                (chunk) =>
                  chunk.kind === "window" &&
                  chunk.startLine <= node.endLine &&
                  chunk.endLine >= node.startLine,
              ),
            });
        }
        for (const child of node.children ?? []) visit(child, depth + 1);
      };
      for (const node of observation.outline.topLevel) visit(node, 0);
      outlineLimits.push(row);
    },
  );
  const manifest = Manifest.parse(
    JSON.parse(await Bun.file(join(benchmark, "manifest.json")).text()),
  );
  const cases = values["head-only"]
    ? []
    : values.split === undefined
      ? manifest.cases
      : splitCases(manifest.cases, parseSplit(values.split));
  const pairs = new Set<string>();
  const blobs = new Set<string>();
  const repositoryBlobs = new Set<string>();
  const seenFiles = new Set<string>();
  type Stats = {
    files: number;
    reasons: Record<string, number>;
    sizes: number[];
    windows: number;
  };
  const stats: Record<string, Stats> = {};
  const counter = await Effect.runPromise(
    EncoderProcess.start(values.python ?? join(work, "venv/bin/python")),
  );
  const tokenCache = new Map<string, number>();
  const perHunk: Array<{
    split: string;
    family: string;
    caseId: string;
    hunkId: string;
    query: "own" | "old-frozen";
    metrics: ReturnType<typeof evaluateHunk>;
  }> = [];
  const layer = benchStoreLayer(resolve(values.store));
  const program = Effect.gen(function* () {
    yield* counter.counter(yield* fetchCounter(work));
    const blobStore = yield* Blobs.BlobStore;
    const textCache = new Map<string, string>();
    const textOf = (hash: string) =>
      Effect.gen(function* () {
        const held = textCache.get(hash);
        if (held !== undefined) return held;
        const read = yield* blobStore.get(hash);
        if (read._tag === "Pruned") throw new Error(`Pruned chunk ${hash}`);
        const text = new TextDecoder().decode(read.bytes);
        textCache.set(hash, text);
        return text;
      });
    const readBase = (
      repository: "neuve" | "neuve_effect",
      commit: string,
      collect: boolean,
    ) =>
      Effect.gen(function* () {
        measuring = collect ? "corpus" : "head";
        const result = yield* baseView(
          repository,
          repositories[repository],
          commit,
          variant,
        );
        measuring = undefined;
        const occurrences: Occurrence[] = [];
        const texts: string[] = [];
        const headPairs = new Set<string>();
        const headBlobs = new Set<string>();
        for (const file of result.view.files) {
          const chunked = result.chunks.get(file.chunkKey);
          if (!chunked || chunked.excluded !== null) continue;
          const fileKey = `${repository}\0${file.path}\0${file.blob}`;
          const unique = collect && !seenFiles.has(fileKey);
          if (collect) {
            seenFiles.add(fileKey);
            blobs.add(file.blob);
            repositoryBlobs.add(`${repository}\0${file.blob}`);
          }
          headBlobs.add(file.blob);
          const group = /\.(tsx?|jsx?|[mc][jt]s)$/i.test(file.path)
            ? "TS-JS"
            : "rest";
          const stat = (stats[group] ??= {
            files: 0,
            reasons: {},
            sizes: [],
            windows: 0,
          });
          if (unique) {
            stat.files++;
            const reason = chunked.fallback ?? "none";
            stat.reasons[reason] = (stat.reasons[reason] ?? 0) + 1;
          }
          for (const [position, chunk] of chunked.chunks.entries()) {
            const pair = `${chunk.hash}\0${file.path}`;
            headPairs.add(pair);
            if (collect) pairs.add(pair);
            const text = yield* textOf(chunk.hash);
            if (unique) {
              stat.sizes.push(Buffer.byteLength(text));
              if (chunk.kind === "window") stat.windows++;
            }
            occurrences.push({
              chunkId: chunkId(file.path, chunk.startLine, chunk.endLine),
              path: file.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              hash: chunk.hash,
              kind: kindOf(file.path),
              chunkKey: file.chunkKey,
              position,
            });
            texts.push(text);
          }
        }
        const ordered = occurrences
          .map((item, index) => ({ item, text: texts[index] ?? "" }))
          .sort((a, b) =>
            a.item.chunkId < b.item.chunkId
              ? -1
              : a.item.chunkId > b.item.chunkId
                ? 1
                : 0,
          );
        const missing = ordered.filter(
          ({ item }) => !tokenCache.has(item.hash),
        );
        for (
          let offset = 0;
          !values["index-only"] && offset < missing.length;
          offset += 256
        ) {
          const batch = missing.slice(offset, offset + 256);
          const counts = yield* counter.count(batch.map(({ text }) => text));
          batch.forEach(({ item }, index) =>
            tokenCache.set(item.hash, counts[index] ?? 0),
          );
        }
        const items: Item[] = ordered.map(({ item }) => ({
          key: item.chunkId,
          path: item.path,
          startLine: item.startLine,
          endLine: item.endLine,
          kind: item.kind,
          tokens: tokenCache.get(item.hash) ?? 0,
          chunkId: item.chunkId,
          hash: item.hash,
        }));
        return {
          index: buildIndex(
            ordered.map(({ item, text }) => `${item.path}\n${text}`),
          ),
          occurrences: ordered.map(({ item }) => item),
          items: new Map(items.map((item) => [item.key, item])),
          headPairs: [...headPairs],
          headBlobs: headBlobs.size,
        };
      });
    for (const split of selectedSplits) {
      const selected = cases.filter((entry) => entry.split === split.name);
      if (selected.length === 0) continue;
      const caseOf = new Map(
        selected.flatMap((entry) =>
          entry.hunks.map((hunk) => [hunk.id, entry.id] as const),
        ),
      );
      const gold = yield* Effect.promise(() =>
        loadGold(join(benchmark, "labelling", split.folder), (hunkId) =>
          caseOf.get(hunkId),
        ),
      );
      const bases = new Map<string, Case[]>();
      for (const entry of selected) {
        const key = `${entry.repository}:${entry.base}`;
        const group = bases.get(key) ?? [];
        group.push(entry);
        bases.set(key, group);
      }
      for (const [key, entries] of bases) {
        const first = entries[0];
        if (!first) continue;
        console.log(`${values.chunker} ${split.name} ${key}`);
        const base = yield* readBase(first.repository, first.base, true);
        if (values["index-only"]) continue;
        for (const entry of entries)
          for (const hunk of entry.hunks) {
            const labels = gold.get(hunk.id);
            if (!labels) throw new Error(`Missing gold for ${hunk.id}`);
            const old = yield* buildQuery(
              repositories[entry.repository],
              entry,
              hunk,
            );
            const own =
              variant === undefined
                ? old
                : yield* buildQuery(
                    repositories[entry.repository],
                    entry,
                    hunk,
                    variant,
                  );
            for (const query of variant === undefined
              ? [{ kind: "own" as const, value: own }]
              : [
                  { kind: "own" as const, value: own },
                  { kind: "old-frozen" as const, value: old },
                ]) {
              const ranked = bm25Ranking(
                base.index,
                base.occurrences,
                query.value.text,
              );
              const items: Item[] = [];
              const scores: number[] = [];
              let tokens = 0;
              for (const row of ranked) {
                const item = base.items.get(row.occurrence.chunkId);
                if (!item) continue;
                items.push(item);
                scores.push(row.score);
                tokens += item.tokens;
                if (tokens >= 512_000) break;
              }
              const ranking: Ranking = { items, scores };
              const metrics = evaluateHunk(
                labels,
                ranking,
                {
                  caseId: entry.id,
                  hunkId: hunk.id,
                  family: entry.family,
                  realShare: hunk.realShare,
                  computedShare: hunk.computedShare,
                },
                variant === undefined ? "L" : undefined,
                [...ALLOWANCES, "opus"],
              );
              perHunk.push({
                split: split.name,
                family: entry.family,
                caseId: entry.id,
                hunkId: hunk.id,
                query: query.kind,
                metrics,
              });
            }
          }
      }
    }
    const corpusUsage = [...usage];
    const head = values["skip-head"]
      ? { headPairs: [], headBlobs: 0 }
      : yield* readBase("neuve", "HEAD", false);
    const summaries = selectedSplits.flatMap((split) =>
      (variant === undefined
        ? ["own" as const]
        : ["own" as const, "old-frozen" as const]
      ).map((query) => {
        const rows = perHunk.filter(
          (row) => row.split === split.name && row.query === query,
        );
        const mean = (
          read: (metrics: ReturnType<typeof evaluateHunk>) => number | null,
        ) =>
          familyMean(
            rows.map((row) => ({
              caseId: row.caseId,
              family: row.family,
              value: read(row.metrics),
            })),
          ).mean;
        return {
          split: split.name,
          query,
          hunks: rows.length,
          recall: Object.fromEntries(
            [...ALLOWANCES, "opus" as const].map((budget) => {
              const label = budgetLabel(budget);
              return [
                label,
                {
                  necessary: mean(
                    (metrics) =>
                      metrics.budgets[label]?.necessary.fractional ?? null,
                  ),
                  relevant: mean(
                    (metrics) =>
                      metrics.budgets[label]?.relevant.fractional ?? null,
                  ),
                  misleading: mean(
                    (metrics) =>
                      metrics.budgets[label]?.attribution.misleadingShare ??
                      null,
                  ),
                  unjudgedTokenShare: mean((metrics) => {
                    const share =
                      metrics.budgets[label]?.attribution.judgedTokenShare;
                    return share === null || share === undefined
                      ? null
                      : 1 - share;
                  }),
                },
              ];
            }),
          ),
          mrr: mean((metrics) => metrics.positions?.reciprocalRank ?? null),
          ndcg10: mean((metrics) => metrics.ndcg10),
          unjudged10: mean((metrics) =>
            metrics.judgedAt[10] === null || metrics.judgedAt[10] === undefined
              ? null
              : 1 - metrics.judgedAt[10],
          ),
        };
      }),
    );
    const describe = (stat: Stats) => {
      const sizes = [...stat.sizes].sort((a, b) => a - b);
      return {
        files: stat.files,
        fallbackReasons: stat.reasons,
        chunks: sizes.length,
        meanBytes:
          sizes.reduce((sum, size) => sum + size, 0) /
          Math.max(1, sizes.length),
        p95Bytes: sizes[Math.max(0, Math.ceil(sizes.length * 0.95) - 1)] ?? 0,
        windowShare: stat.windows / Math.max(1, sizes.length),
      };
    };
    const times = (rows: GraphCommandUsage[]) => ({
      commands: rows.filter((row) => row.stage === "symbols").length,
      wallSeconds:
        rows
          .filter((row) => row.stage === "symbols")
          .reduce((sum, row) => sum + row.wallMs, 0) / 1000,
      cpuSeconds:
        rows
          .filter((row) => row.stage === "symbols")
          .reduce(
            (sum, row) =>
              sum + (row.cpu?.userMs ?? 0) + (row.cpu?.systemMs ?? 0),
            0,
          ) / 1000,
    });
    const result = {
      chunker: values.chunker,
      key: variant?.key ?? { recipe: "neuve-bench-chunk-v1" },
      bm25: BM25,
      outlines:
        variant?.provider.capabilities.optionalLocalOnlyFeatures[
          "symbols_outline"
        ] ?? false,
      summaries,
      stats: Object.fromEntries(
        Object.entries(stats).map(([key, stat]) => [key, describe(stat)]),
      ),
      proof4: {
        corpus: {
          blobs: blobs.size,
          repositoryBlobs: repositoryBlobs.size,
          fileBlobs: seenFiles.size,
          pairs: pairs.size,
          graph: times(corpusUsage),
        },
        head: {
          blobs: head.headBlobs,
          pairs: head.headPairs.length,
          graph: times(usage.slice(corpusUsage.length)),
        },
      },
    };
    yield* Effect.promise(() =>
      writeOutput(
        join(output, "results.json"),
        JSON.stringify(result, null, 2),
      ),
    );
    yield* Effect.promise(() =>
      writeOutput(
        join(output, "inventory.json"),
        JSON.stringify({ corpus: [...pairs], head: head.headPairs }),
      ),
    );
    yield* Effect.promise(() =>
      writeOutput(join(output, "per-hunk.json"), JSON.stringify(perHunk)),
    );
    yield* Effect.promise(() =>
      writeOutput(join(output, "graph-usage.json"), JSON.stringify(usage)),
    );
    yield* Effect.promise(() =>
      writeOutput(
        join(output, "outline-limits.json"),
        JSON.stringify(outlineLimits),
      ),
    );
    console.log(JSON.stringify(result));
  });
  try {
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  } finally {
    await Effect.runPromise(counter.close());
  }
};

if (import.meta.main) await main();
