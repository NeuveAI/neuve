// Why: a tree index with retryable Graph fallbacks was kept nowhere, so every finder call rebuilt it
// and re-read Graph for every blob. It must be built once per review, still disclose its fallbacks,
// never outlive the process's review, and be retried when the next review starts.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Tracer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { CodeWork } from "../src/code-work.ts";
import { lsTree } from "../src/git-objects.ts";
import {
  captureOutlineSource,
  outlineExecutable,
  type OutlineSource,
} from "../src/graph-outline.ts";
import {
  blobChunks,
  forgetDegradedIndexes,
  indexRecipe,
  treeIndex,
} from "../src/search-index.ts";
import { PublicationPolicy } from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

const root = mkdtempSync(join(tmpdir(), "degraded-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (args: string[], input?: string) => {
  const child = Bun.spawnSync(["git", "-C", root, ...args], {
    ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
git(["init", "-q"]);
const tree = (path: string, text: string) =>
  git(
    ["mktree"],
    `100644 blob ${git(["hash-object", "-w", "--stdin"], text)}\t${path}\n`,
  );

/** Graph is not installed at this path: every outline read is unavailable, which is retryable. */
const unavailable = (name: string): OutlineSource => ({
  executable: join(root, name),
  key: { unavailable: join(root, name) },
});

let builds = 0;
const counting = Tracer.make({
  span: (options) => {
    if (options.name === "harness.index.tree") builds++;
    return Tracer.nativeTracer.span(options);
  },
});
const codeWork = join(root, "code-work-state");
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
      Effect.provideService(
        CodeWork,
        worker ? { directory: codeWork, background: false } : undefined,
      ),
      Effect.provideService(Tracer.Tracer, counting),
      Effect.provide(layer),
    ),
  );
};
const snapshotFile = (revision: string, source: OutlineSource) =>
  join(
    codeWork,
    "code-work",
    "indexes",
    `${createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          tree: revision,
          recipe: indexRecipe(source),
        }),
      )
      .digest("hex")}.index`,
  );

// The regression: a review's repeated finder calls rebuilt the same degraded tree each time.
test("a degraded index is built once in a process and served from the cache after", async () => {
  const head = tree("once.ts", "export const once = 1;\n");
  const source = unavailable("absent-once");
  const before = builds;
  const first = await run(treeIndex(root, head, source), "once");
  const second = await run(treeIndex(root, head, source), "once");
  expect(builds - before).toBe(1);
  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(second.index).toBe(first.index);
  // The limitation stays visible on chunks served from the cache.
  expect(second.index.chunks.length).toBeGreaterThan(0);
  expect(second.index.chunks.map((chunk) => chunk.fallback)).toEqual(
    second.index.chunks.map(() => "capability-unavailable"),
  );
});

// No needless rebuild: forgetting is only for degraded indexes.
test("forgetting degraded indexes leaves a healthy index in place", async () => {
  const source = unavailable("absent-healthy");
  // Markdown never goes to Graph, so its index is healthy even without Graph.
  const healthy = tree("plan.md", "# Plan\nhealthy body\n");
  const degraded = tree("degraded.ts", "export const degraded = 1;\n");
  await run(treeIndex(root, healthy, source), "healthy");
  await run(treeIndex(root, degraded, source), "healthy");
  forgetDegradedIndexes();
  const before = builds;
  const kept = await run(treeIndex(root, healthy, source), "healthy");
  expect(kept.cached).toBe(true);
  expect(builds - before).toBe(0);
  const retried = await run(treeIndex(root, degraded, source), "healthy");
  expect(retried.cached).toBe(false);
  expect(builds - before).toBe(1);
});

// It must not outlive the process's review: no snapshot file, and no reuse by another caller.
test("a degraded index writes no snapshot and is not returned by an unreferenced publication read", async () => {
  const directory = join(root, "publication-budget");
  const authority = publicationHost(directory);
  const original = SharedWork.prototype.run;
  const prior = process.env.NEUVE_BUDGET_DIRECTORY;
  let published: Parameters<typeof original>[0]["crossProcess"];
  let publication: string | undefined;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  SharedWork.prototype.run = new Proxy(original, {
    apply(target, receiver, args) {
      const options: Parameters<typeof original>[0] = args[0];
      if (!options.key.startsWith("tree-index@1") || !options.crossProcess)
        return Reflect.apply(target, receiver, args);
      published = { ...options.crossProcess, transport: authority.transport };
      return Reflect.apply(target, receiver, [
        {
          ...options,
          crossProcess: published,
          run: async (signal: AbortSignal) => {
            const stored = await options.run(signal);
            if ("publication" in stored) publication = stored.publication;
            return stored;
          },
        },
      ]);
    },
  });
  const source = unavailable("absent-publication");
  const index = (revision: string) =>
    run(
      treeIndex(root, revision, source).pipe(
        Effect.provideService(PublicationPolicy, {
          ...PublicationPolicy.defaultValue(),
          authority: authority.authority,
        }),
      ),
      "publication",
      true,
    );
  try {
    // A healthy tree shows the read finds what was published.
    const healthy = tree("notes.md", "# Notes\npublished body\n");
    await index(healthy);
    expect(existsSync(snapshotFile(healthy, source))).toBe(true);
    expect((await published?.read(undefined))?.outcome.kind).toBe("succeeded");
    const degraded = tree("kept.ts", "export const kept = 1;\n");
    publication = undefined;
    const built = await index(degraded);
    expect(built.index.chunks[0]?.fallback).toBe("capability-unavailable");
    expect(existsSync(snapshotFile(degraded, source))).toBe(false);
    // Its own subscribers receive it by reference; an unreferenced reader never reuses it.
    expect(publication).toBeDefined();
    expect((await published?.read(publication))?.outcome.kind).toBe(
      "succeeded",
    );
    expect(await published?.read(undefined)).toBeUndefined();
  } finally {
    SharedWork.prototype.run = original;
    authority.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
  }
}, 30_000);

// `partial` is fixed by the blobs and the chunker recipe, so it no longer makes an index degraded.
test("a snapshot with a partial path and no retryable chunk is served", async () => {
  const { deserialize, serialize } = await import("node:v8");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const source = unavailable("absent-partial");
  const head = tree("partial.md", "# Partial\nkept as built\n");
  await run(treeIndex(root, head, source), "partial", true);
  const file = snapshotFile(head, source);
  const snapshot = deserialize(readFileSync(file));
  writeFileSync(
    file,
    serialize({ ...snapshot, partial: new Set(["partial.md"]) }),
  );
  // Two other trees, built without a snapshot, push this one out of the process's cache.
  for (const other of ["# One\n", "# Two\n"])
    await run(treeIndex(root, tree("other.md", other), source), "partial");
  const before = builds;
  const served = await run(treeIndex(root, head, source), "partial", true);
  expect(builds - before).toBe(0);
  expect(served.cached).toBe(true);
  expect([...served.index.partial]).toEqual(["partial.md"]);
});

const graphInstalled = existsSync(outlineExecutable());
// The next review must retry: after forgetting, Graph is asked again and the blob takes its stable key.
test.skipIf(!graphInstalled)(
  "after forgetting, a degraded index is rebuilt with Graph and then kept and reused",
  async () => {
    const head = tree("retry.ts", "export function retried() { return 1; }\n");
    const previous = process.env.TMPDIR;
    // Same executable and source key; Graph fails only because its temporary folder is missing.
    process.env.TMPDIR = join(root, "missing-temporary-parent");
    let first;
    try {
      first = await run(
        treeIndex(root, head, captureOutlineSource()),
        "retry",
        true,
      );
    } finally {
      process.env.TMPDIR = previous;
    }
    expect(first.index.chunks[0]?.fallback).toBe("capability-unavailable");
    expect(existsSync(snapshotFile(head, captureOutlineSource()))).toBe(false);
    // Still degraded in this process until forgotten.
    expect(
      (await run(treeIndex(root, head, captureOutlineSource()), "retry", true))
        .cached,
    ).toBe(true);
    forgetDegradedIndexes();
    const before = builds;
    const second = await run(
      treeIndex(root, head, captureOutlineSource()),
      "retry",
      true,
    );
    expect(builds - before).toBe(1);
    expect(second.cached).toBe(false);
    expect(second.index.chunks[0]?.fallback).toBeNull();
    expect(second.index.chunks[0]?.capability).toBe("graph-symbols");
    // The blob's chunks now sit under its stable key: a later pass reuses them without Graph.
    const stable = await run(
      Effect.flatMap(lsTree(root, head), (entries) =>
        blobChunks(root, entries, captureOutlineSource()),
      ),
      "retry",
    );
    expect({ computed: stable.computed, reused: stable.reused }).toEqual({
      computed: 0,
      reused: 1,
    });
    // Healthy now: kept in the cache and the snapshot, and forgetting no longer drops it.
    expect(existsSync(snapshotFile(head, captureOutlineSource()))).toBe(true);
    forgetDegradedIndexes();
    const third = await run(
      treeIndex(root, head, captureOutlineSource()),
      "retry",
      true,
    );
    expect(third.cached).toBe(true);
    expect(builds - before).toBe(1);
    expect(
      readdirSync(join(codeWork, "code-work", "indexes")).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
  },
  60_000,
);
