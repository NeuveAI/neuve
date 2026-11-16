import { afterAll, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { join } from "node:path";

import {
  refuseCommittedOutput as refuseOutput,
  stagePaths,
} from "../src/retrieval-bench/stage-paths.ts";

const fixture = mkdtempSync(join(tmpdir(), "bench-committed-"));
const benchmarkRoot = join(fixture, "committed");
mkdirSync(benchmarkRoot);
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
const refuseCommittedOutput = (path: string) =>
  refuseOutput(path, benchmarkRoot);

const withOutputVolume = <T>(volume: string | undefined, run: () => T): T => {
  const previous = process.env.NEUVE_BENCH_OUTPUT_VOLUME;
  if (volume === undefined) delete process.env.NEUVE_BENCH_OUTPUT_VOLUME;
  else process.env.NEUVE_BENCH_OUTPUT_VOLUME = volume;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.NEUVE_BENCH_OUTPUT_VOLUME;
    else process.env.NEUVE_BENCH_OUTPUT_VOLUME = previous;
  }
};

// The output boundary must follow the configured volume, including resolved symlinks.
test("Graph output stays strictly beneath the configured volume", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-volume-"));
  const volume = join(dir, "volume");
  const outside = join(dir, "outside");
  mkdirSync(volume);
  mkdirSync(outside);
  const paths = (outputRoot: string) =>
    stagePaths({ outputRoot, chunker: "graph", splitFolder: "dev" });
  try {
    withOutputVolume(undefined, () => {
      expect(() => paths(join(volume, "run"))).toThrow(
        "NEUVE_BENCH_OUTPUT_VOLUME",
      );
    });
    withOutputVolume(volume, () => {
      expect(paths(join(volume, "run"))?.root).toBe(join(volume, "run"));
      for (const root of [volume, outside, volume + "-sibling"])
        expect(() => paths(root)).toThrow("configured volume");
      symlinkSync(outside, join(volume, "escape"));
      expect(() => paths(join(volume, "escape", "new"))).toThrow(
        "configured volume",
      );
      symlinkSync(volume, join(dir, "alias"));
      expect(paths(join(dir, "alias", "run"))?.root).toBe(
        join(dir, "alias", "run"),
      );
    });
    withOutputVolume(join(dir, "alias"), () => {
      expect(paths(join(volume, "run"))?.root).toBe(join(volume, "run"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Missing repository configuration must fail before the measurement launches Graph or writes output.
test("symbol-batch measurement requires an explicitly configured effect repository", async () => {
  const { existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bench-measure-config-"));
  const out = join(dir, "report.json");
  const env = { ...process.env };
  delete env.NEUVE_EFFECT_REPOSITORY;
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(
          import.meta.dir,
          "../src/retrieval-bench/measure-symbol-batches.ts",
        ),
        "--executable",
        join(dir, "unused-engine"),
        "--work",
        join(dir, "work"),
        "--out",
        out,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [error, exit] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(exit).not.toBe(0);
    expect(error).toContain("NEUVE_EFFECT_REPOSITORY is required");
    expect(existsSync(out)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Graph runs share work and store across splits while keeping logs separate", () => {
  const volume = mkdtempSync(join(tmpdir(), "bench-stage-volume-"));
  try {
    withOutputVolume(volume, () => {
      const options = {
        outputRoot: join(volume, "run"),
        chunker: "graph" as const,
      };
      const dev = stagePaths({ ...options, splitFolder: "dev" });
      const heldout = stagePaths({ ...options, splitFolder: "heldout" });
      expect(dev?.store).toBe(heldout?.store);
      expect(dev?.work).toBe(heldout?.work);
      expect(dev?.output).toBe(heldout?.output);
      expect(dev?.log).not.toBe(heldout?.log);
    });
  } finally {
    rmSync(volume, { recursive: true });
  }
});

// The shared store cannot prevent repeats submitted together before scores are stored.
test("reranker submits a pending pair once across repeated documents and queries", async () => {
  const { uniquePairIndices } =
    await import("../src/retrieval-bench/rerank.ts");
  const seen = new Set<string>();
  expect(
    uniquePairIndices(
      { sha256: "q1" },
      ["same", "same", "other"],
      [0, 1, 2],
      seen,
    ),
  ).toEqual([0, 2]);
  expect(
    uniquePairIndices({ sha256: "q1" }, ["other", "new"], [0, 1], seen),
  ).toEqual([1]);
  expect(uniquePairIndices({ sha256: "q2" }, ["same"], [0], seen)).toEqual([0]);
});

// The reviewer found both unchecked descendants and dangling file symlinks.
test("actual score, pool and dangling --out destinations cannot redirect writes", async () => {
  const { mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bench-destinations-"));
  try {
    mkdirSync(join(dir, "graph", "scores"), { recursive: true });
    mkdirSync(join(dir, "graph", "pools"), { recursive: true });
    for (const kind of ["scores", "pools"]) {
      symlinkSync(benchmarkRoot, join(dir, "graph", kind, "dev"));
      expect(() =>
        refuseCommittedOutput(join(dir, "graph", kind, "dev", "new.json")),
      ).toThrow("Refusing");
    }
    symlinkSync(
      join(benchmarkRoot, "not-created-by-this-test.jsonl"),
      join(dir, "units.jsonl"),
    );
    expect(() => refuseCommittedOutput(join(dir, "units.jsonl"))).toThrow(
      "Refusing",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// A successful ranking from the fallback view must not be found after parsing recovers.
test("fallback recovery changes the resolved view and persistent deep-ranking key", async () => {
  const { Effect } = await import("effect");
  const { Computations } = await import("@neuve/records-core");
  const { baseView, benchStoreLayer } =
    await import("../src/retrieval-bench/views.ts");
  const { chunkerKey } = await import("../../harness/src/chunker.ts");
  const { deepSpec } = await import("../src/retrieval-bench/run-pools.ts");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "bench-fallback-"));
  try {
    const git = async (args: string[], input?: string) => {
      const p = Bun.spawn(["git", "-C", dir, ...args], {
        stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(p.stdout).text();
      if ((await p.exited) !== 0)
        throw new Error(await new Response(p.stderr).text());
      return stdout.trim();
    };
    await git(["init", "--quiet"]);
    const source = "export const a = 1;\n".repeat(64);
    const blob = await git(["hash-object", "-w", "--stdin"], source);
    const tree = await git(["mktree"], `100644 blob ${blob}\ta.ts\n`);
    const provider = {
      name: "entire-graph",
      version: "fixture",
      identityRevision: "4",
      executable: { sha256: "e".repeat(64), buildIdentity: "unreported" },
      capabilities: {
        schemaVersion: "1.3",
        supportedFileExtensions: [".ts"],
        supportedLanguages: ["TypeScript"],
        semanticLanguages: ["TypeScript"],
        inventoryOnlyLanguages: [],
        supportedRelationTypes: ["DEFINES", "CONTAINS"],
        relationSelectionModes: ["exact"],
        relationFamilies: {},
        relationSupportByLanguage: {},
        relationSupportByProfile: { "syntax-only": ["DEFINES", "CONTAINS"] },
        heuristicRelationTypes: [],
        parserVersions: {},
        unsupportedButDetectedLanguageHints: [],
        optionalLocalOnlyFeatures: { symbols_outline: true },
        featuresRequiringNetworkAccess: {},
      },
    } satisfies import("@neuve/graph-client").GraphProviderObservation;
    let recovered = false;
    const variant = {
      provider,
      key: chunkerKey(provider),
      chunk: async () =>
        new Map([
          [
            "a.ts",
            {
              capability: recovered
                ? ("graph-symbols" as const)
                : ("utf8-line-window-4k-v2" as const),
              language: "TypeScript",
              fallback: recovered ? undefined : ("parse-error" as const),
              chunks: (recovered
                ? [
                    [1, 32],
                    [33, 64],
                  ]
                : [[1, 64]]
              ).map(([start = 1, end = 64]) => {
                const text = source
                  .split(/(?<=\n)/)
                  .slice(start - 1, end)
                  .join("");
                return {
                  kind: recovered ? ("symbol" as const) : ("window" as const),
                  symbol: undefined,
                  startLine: start,
                  endLine: end,
                  text,
                  headingPath: [],
                  identifiers: [],
                  callables: [],
                  textSha256: createHash("sha256").update(text).digest("hex"),
                };
              }),
            },
          ],
        ]),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* baseView("neuve", dir, tree, variant);
        recovered = true;
        const second = yield* baseView("neuve", dir, tree, variant);
        expect(first.view.files[0]?.chunkKey).not.toBe(
          second.view.files[0]?.chunkKey,
        );
        expect(first.viewKey).not.toBe(second.viewKey);
        const makeSpec = (viewKey: string) =>
          deepSpec(
            "L",
            {},
            {
              repository: "neuve",
              commit: tree,
              viewKey,
              occurrences: [],
              files: [],
            },
            {
              hunkId: "h",
              text: "same",
              sha256: "q",
              caseId: "c",
              repository: "neuve",
              base: tree,
              head: tree,
              path: "a.ts",
              side: "pre",
              startLine: 1,
              endLine: 1,
              symbols: [],
              droppedLines: 0,
            },
          );
        const store = yield* Computations.ComputationStore;
        yield* store.run(
          makeSpec(first.viewKey),
          Effect.succeed({
            bytes: new TextEncoder().encode('"a.ts#L1-L64"'),
            mediaType: "application/json",
          }),
        );
        const after = yield* store.run(
          makeSpec(second.viewKey),
          Effect.succeed({
            bytes: new TextEncoder().encode('"a.ts#L1-L32"'),
            mediaType: "application/json",
          }),
        );
        expect(after.status).toBe("computed");
      }).pipe(Effect.provide(benchStoreLayer(join(dir, "store")))),
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// LaCie's case-insensitive volume also resolves these names to the committed directory.
test("write protection resolves existing directory case aliases", async () => {
  const { lstatSync } = await import("node:fs");
  const alias = join(fixture, "COMMITTED");
  let same = false;
  try {
    same = lstatSync(alias).ino === lstatSync(benchmarkRoot).ino;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (same)
    expect(() =>
      refuseCommittedOutput(join(alias, "not-created.json")),
    ).toThrow("Refusing");
});

// Library callers can check a supplied committed directory without archive data.
test("output refuses committed destinations and symlink aliases", () => {
  expect(() => refuseCommittedOutput(benchmarkRoot)).toThrow("Refusing");
  expect(() => refuseCommittedOutput("/")).toThrow("Refusing");
  const dir = mkdtempSync(join(tmpdir(), "bench-stage-test-"));
  try {
    symlinkSync(benchmarkRoot, join(dir, "alias"));
    expect(() => refuseCommittedOutput(join(dir, "alias", "new"))).toThrow(
      "Refusing",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
