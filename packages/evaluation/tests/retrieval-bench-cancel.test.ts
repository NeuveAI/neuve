import { Manifest } from "../src/retrieval-bench/manifest.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { GraphCommandUsage } from "@neuve/graph-client";
import { outlineExecutable } from "../../harness/src/graph-outline.ts";
import { buildQuery } from "../src/retrieval-bench/queries.ts";
import { changedSymbols } from "../src/retrieval-bench/graph.ts";
import { cancellationManifest } from "./fixtures/retrieval-cancel-manifest.ts";
import { baseView, benchStoreLayer } from "../src/retrieval-bench/views.ts";
import { graphChunkVariant } from "../src/retrieval-bench/graph-chunk.ts";

// Interruption must stop the engine itself, including the command already launched by a view.
for (const mode of ["view", "query", "changed-symbols"] as const)
  test(`interrupting a one-file benchmark ${mode} aborts its real Graph symbols command`, async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-cancel-"));
    const controller = new AbortController();
    try {
      const git = (args: string[], input?: string) => {
        const child = Bun.spawnSync(["git", "-C", root, ...args], {
          ...(input === undefined
            ? {}
            : { stdin: new TextEncoder().encode(input) }),
        });
        if (child.exitCode) throw new Error(child.stderr.toString());
        return child.stdout.toString().trim();
      };
      git(["init", "-q"]);
      const blob = git(
        ["hash-object", "-w", "--stdin"],
        "export function alpha(){return 1;}\n",
      );
      const tree = git(["mktree"], `100644 blob ${blob}\ta.ts\n`);
      const usage: GraphCommandUsage[] = [];
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let initialized = false;
      const real = await graphChunkVariant(outlineExecutable(), root, {
        onCommandUsage: (item) => {
          usage.push(item);
          if (item.stage === "symbols_init") initialized = true;
        },
        spawnProcess: async (launch) => {
          const child = launch();
          if (initialized) began();
          return child;
        },
      });
      let pending: ReturnType<typeof real.chunk> | undefined;
      const variant: typeof real = {
        ...real,
        chunk: (...args) => {
          pending = real.chunk(...args);
          // Observe rejection immediately; the assertion below still checks its outcome.
          void pending.catch(() => {});
          return pending;
        },
      };
      const hunk = Manifest.shape.cases.element.shape.hunks.element.parse({
        id: "h-000000000001",
        path: "a.ts",
        oldPath: "a.ts",
        added: 1,
        deleted: 0,
        new: { start: 1, lines: 1 },
        old: { start: 1, lines: 1 },
        changedLines: 1,
        tunedFile: false,
        computedShare: { opus: 1000, sol: 1000 },
        realShare: { opus: 1000, sol: 1000 },
        raisedToMinimum: { opus: false, sol: false },
      });
      const entry = Manifest.shape.cases.element.parse({
        id: "fixture",
        repository: "neuve",
        base: tree,
        head: tree,
        kind: "direct",
        commits: [tree],
        subjects: [],
        family: "fixture",
        split: "dev",
        strata: {
          changeType: "fix",
          size: "S",
          scopeSource: "none",
          area: "fixture",
        },
        changedLines: 1,
        reviewLines: 1,
        dataLines: 0,
        period: "2026-Q4",
        codeFiles: 1,
        scopeDocsAtBase: [],
        inRangeDocs: [],
        tunedFiles: [],
        phase2Files: [],
        graphTuningRange: false,
        leakageTags: [],
        hunks: [hunk],
      });
      const work =
        mode === "query"
          ? buildQuery(root, entry, hunk, variant).pipe(Effect.asVoid)
          : mode === "changed-symbols"
            ? changedSymbols(root, entry, hunk, variant).pipe(Effect.asVoid)
            : baseView("neuve", root, tree, variant).pipe(Effect.asVoid);
      const outer = Effect.runPromise(
        work.pipe(Effect.provide(benchStoreLayer(join(root, "records")))),
        { signal: controller.signal },
      ).then(
        () => "completed",
        () => "interrupted",
      );
      await started;
      controller.abort(new Error("cancel benchmark view"));
      const viewOutcome = await outer;
      const readOutcome = await pending!.then(
        () => "completed",
        () => "cancelled",
      );
      const symbolsAborted = usage
        .filter((item) => item.stage === "symbols")
        .map((item) => item.aborted);
      console.info(
        JSON.stringify({ mode, viewOutcome, readOutcome, symbolsAborted }),
      );
      expect(viewOutcome).toBe("interrupted");
      expect(readOutcome).toBe("cancelled");
      expect(symbolsAborted).toEqual([true]);
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

// Default variants are also constructed under Effect.tryPromise before any file is chunked.
test("benchmark variant setup aborts its provider command", async () => {
  const { chmodSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "bench-provider-cancel-"));
  const executable = join(root, "engine");
  await Bun.write(
    executable,
    `#!${process.execPath}\nawait Bun.sleep(1000); process.exit(1);\n`,
  );
  chmodSync(executable, 0o700);
  const controller = new AbortController();
  const usage: GraphCommandUsage[] = [];
  let done!: () => void;
  const ended = new Promise<void>((resolve) => {
    done = resolve;
  });
  try {
    await expect(
      graphChunkVariant(
        executable,
        root,
        {
          onCommandUsage: (item) => {
            usage.push(item);
            done();
          },
          spawnProcess: async (launch) => {
            const child = launch();
            queueMicrotask(() => controller.abort());
            return child;
          },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    await ended;
    expect(usage.some((item) => item.aborted)).toBe(true);
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

// The leads CLI's plain Promise boundary must pass cancellation to its internal Effect roots.
test("leads root interrupts its in-flight plan before publishing", async () => {
  const { leadsCommand } = await import("../src/retrieval-bench/leads.ts");
  const root = mkdtempSync(join(tmpdir(), "bench-leads-cancel-"));
  const controller = new AbortController();
  let published = false;
  try {
    const manifest = cancellationManifest;
    await expect(
      leadsCommand({
        signal: controller.signal,
        flag: (name) => (name === "--stage" ? "plan" : undefined),
        flags: () => [],
        has: () => false,
        output: root,
        work: root,
        storeDir: root,
        logDir: root,
        repositories: { neuve: root, neuve_effect: root },
        devCases: () => {
          queueMicrotask(() => controller.abort());
          return [manifest.cases[0]!];
        },
        readManifest: async () => manifest,
        log: () => {},
        record: async () => {
          published = true;
        },
        graphSetup: () => {
          throw new Error("unexpected Graph setup");
        },
        recordedGraphRun: async () => {
          throw new Error("unexpected Graph run");
        },
        graphFailuresPath: () => join(root, "failures.json"),
        pinnedFork: "fixture",
        rerankPairUsd: 0,
      }),
    ).rejects.toThrow(/interrupt/i);
    expect(controller.signal.aborted).toBe(true);
    expect(published).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
