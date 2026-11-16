// Index and hunk callers must see Graph positions or a named, searchable fallback.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  treeIndex,
  blobChunks,
  forgetDegradedIndexes,
  indexRecipe,
} from "../src/search-index.ts";
import { describeHunks } from "../src/hunks.ts";
import { diffTrees } from "../src/git-objects.ts";
const root = mkdtempSync(join(tmpdir(), "graph-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
git("init", "-q");
const tree = (path: string, text: string) => {
  const blob = Bun.spawnSync(
    ["git", "-C", root, "hash-object", "-w", "--stdin"],
    { stdin: new TextEncoder().encode(text) },
  )
    .stdout.toString()
    .trim();
  return Bun.spawnSync(["git", "-C", root, "mktree"], {
    stdin: new TextEncoder().encode(`100644 blob ${blob}\t${path}\n`),
  })
    .stdout.toString()
    .trim();
};
const empty = git("mktree");
const run = <A, E>(
  effect: Effect.Effect<A, E, Computations.ComputationStore | Blobs.BlobStore>,
  name: string,
  worker = false,
) => {
  const location = storeLocationIn(join(root, name));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(
        CodeWork,
        worker
          ? { directory: join(root, "code-work-state"), background: false }
          : undefined,
      ),
      Effect.provide(layer),
    ),
  );
};
const executable = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
test.skipIf(!executable)(
  "Graph index identifiers exclude comments and string contents",
  async () => {
    const head = tree(
      "a.ts",
      'export function alpha(input: string) {\n // ignoredComment\n return input + "ignoredString";\n}\n',
    );
    const result = await run(
      treeIndex(root, head, captureOutlineSource()),
      "available",
    );
    expect(result.index.chunks[0]?.capability).toBe("graph-symbols");
    expect(
      result.index.chunks.flatMap((c) => c.parsedIdentifiers ?? []),
    ).toContain("alpha");
    expect(
      result.index.chunks.flatMap((c) => c.parsedIdentifiers ?? []),
    ).not.toContain("ignoredComment");
    expect(
      result.index.chunks.flatMap((c) => c.parsedIdentifiers ?? []),
    ).not.toContain("ignoredString");
  },
);
for (const [name, path, text, fallback] of [
  [
    "unavailable",
    "a.ts",
    "export const alpha = 1;\n",
    "capability-unavailable",
  ],
  ["unsupported", "a.unknown", "alpha\n", "unsupported-language"],
  ["parse", "a.ts", "export function broken( { return \n", "parse-error"],
  [
    "outline",
    "a_windows.go",
    "package a\nfunc alpha() {}\n",
    "outline-unavailable",
  ],
  [
    "policy",
    "a.json",
    JSON.stringify({ value: "x".repeat(10000) }) + "\n",
    "source-not-parsed",
  ],
] as const)
  test.skipIf(!executable)(
    `${name} fallback is indexed and disclosed on the hunk`,
    async () => {
      const head = tree(path, text);
      const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      if (name === "unavailable")
        process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(root, "absent");
      try {
        const result = await run(
          Effect.gen(function* () {
            const { index } = yield* treeIndex(
              root,
              head,
              captureOutlineSource(),
            );
            const hunks = yield* describeHunks(
              root,
              yield* diffTrees(root, empty, head),
              captureOutlineSource(),
            );
            return { index, hunks };
          }),
          name,
        );
        expect(result.index.chunks.length).toBeGreaterThan(0);
        expect(result.index.chunks[0]?.fallback).toBe(fallback);
        expect(result.hunks[0]?.enclosing?.limitation).toContain(fallback);
      } finally {
        if (previous === undefined)
          delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
        else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
      }
    },
  );

// Markdown must retain its stable heading cache even when Graph is absent.
test("Markdown heading chunks are reused while Graph is unavailable", async () => {
  const text = "# Plan\nbody\n";
  const head = tree("plan.md", text);
  const oid = git("rev-parse", `${head}:plan.md`);
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(root, "absent");
  try {
    const result = await run(
      Effect.gen(function* () {
        const entries = [
          {
            path: "plan.md",
            oid,
            mode: "100644",
            type: "blob",
            size: text.length,
          },
        ];
        const contents = new Map([[oid, new TextEncoder().encode(text)]]);
        const first = yield* blobChunks(
          root,
          entries,
          captureOutlineSource(),
          contents,
        );
        const second = yield* blobChunks(
          root,
          entries,
          captureOutlineSource(),
          contents,
        );
        return { first, second };
      }),
      "markdown",
    );
    expect(result.first.computed).toBe(1);
    expect(result.second.reused).toBe(1);
    expect([...result.second.chunks.values()][0]?.fallback).toBeNull();
  } finally {
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
  }
});

// The worker's outer process cache must obey the blob and snapshot retry policy.
test.skipIf(!executable)(
  "worker retries a transient Graph failure with the same executable",
  async () => {
    const previous = process.env.TMPDIR;
    const head = tree(
      "retry.ts",
      "export function recoverWorker() { return 1; }\n",
    );
    const source = captureOutlineSource().key;
    try {
      process.env.TMPDIR = join(root, "missing-temporary-parent");
      const first = await run(
        treeIndex(root, head, captureOutlineSource()),
        "worker-retry",
        true,
      );
      expect(first.index.chunks[0]?.fallback).toBe("capability-unavailable");
      process.env.TMPDIR = previous;
      // A degraded index is kept for the review that built it; the next review's start forgets it.
      forgetDegradedIndexes();
      const second = await run(
        treeIndex(root, head, captureOutlineSource()),
        "worker-retry",
        true,
      );
      expect(captureOutlineSource().key).toEqual(source);
      expect(second.index.chunks[0]?.fallback).toBeNull();
      expect(second.index.chunks[0]?.capability).toBe("graph-symbols");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  },
);

// A deterministic parse result must be a reusable, published index.
test.skipIf(!executable)(
  "worker caches and publishes a tree with only stable fallbacks",
  async () => {
    const head = tree("stable.ts", "export function broken( { return \n");
    const first = await run(
      treeIndex(root, head, captureOutlineSource()),
      "stable-worker",
      true,
    );
    expect(first.index.chunks[0]?.fallback).toBe("parse-error");
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          tree: head,
          recipe: indexRecipe(captureOutlineSource()),
        }),
      )
      .digest("hex");
    const filename = join(
      root,
      "code-work-state",
      "code-work",
      "indexes",
      `${key}.index`,
    );
    expect(existsSync(filename)).toBe(true);
    expect(deserialize(readFileSync(filename)).chunks[0].fallback).toBe(
      "parse-error",
    );
    const second = await run(
      treeIndex(root, head, captureOutlineSource()),
      "stable-worker",
      true,
    );
    expect(second.cached).toBe(true);
    expect(second.index.chunks).toEqual(first.index.chunks);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
    import {Effect} from "effect";
    import {treeIndex} from ${JSON.stringify(join(import.meta.dir, "../src/search-index.ts"))};
    import {captureOutlineSource} from ${JSON.stringify(join(import.meta.dir, "../src/graph-outline.ts"))};
    import {CodeWork} from ${JSON.stringify(join(import.meta.dir, "../src/code-work.ts"))};
    const result=await Effect.runPromise(treeIndex(${JSON.stringify(root)},${JSON.stringify(head)},captureOutlineSource()).pipe(Effect.provideService(CodeWork,{directory:${JSON.stringify(join(root, "code-work-state"))},background:false})));
    console.log(JSON.stringify({cached:result.cached,fallback:result.index.chunks[0]?.fallback}));
  `,
      ],
      {
        env: { ...process.env, TMPDIR: join(root, "missing-on-snapshot-read") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await output)).toEqual({
      cached: true,
      fallback: "parse-error",
    });
    await errors;
  },
);

// Source identity changes choose a new cache key instead of blocking on the old snapshot.
test.skipIf(!executable)(
  "search index caches recover when a missing executable is installed",
  async () => {
    const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    const head = tree("source-change.ts", "export const sourceIdentity = 1;\n");
    try {
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(
        root,
        "missing-source-executable",
      );
      const first = await run(
        treeIndex(root, head, captureOutlineSource()),
        "source-change",
        true,
      );
      expect(first.index.chunks[0]?.fallback).toBe("capability-unavailable");
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
      const next = await run(
        treeIndex(root, head, captureOutlineSource()),
        "source-change",
        true,
      );
      expect(next.cached).toBe(false);
      expect(next.index.chunks[0]?.fallback).toBeNull();
      expect(
        (
          await run(
            treeIndex(root, head, captureOutlineSource()),
            "source-change",
            true,
          )
        ).cached,
      ).toBe(true);
    } finally {
      if (previous === undefined)
        delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
    }
  },
);
