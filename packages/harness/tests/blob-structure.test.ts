// Why: each blob's structure is stored once, by the pass that already reads Graph for its chunks,
// and read back without a second Graph read (NEU-148). Wrong here, a review either reads Graph twice
// per changed blob, keeps a retryable failure as if it were the file's structure, sends every store
// cold through a silent chunk recipe change, or has two producers write different bytes under one
// key; each would pass unnoticed downstream. Outline reads are observed as `harness.graph.outline`
// spans (one per read Graph is asked for), Graph's availability as in `graph-index.test.ts`: a
// missing temporary parent makes the same engine unavailable. Engine tests run only where the engine
// is built (`bun run build:graph`).
import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { blobStructures, structureKeyOf } from "../src/blob-structure.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import type { TreeEntry } from "../src/git-objects.ts";
import {
  captureOutlineSource,
  outlineExecutable,
  type OutlineSource,
} from "../src/graph-outline.ts";
import {
  blobChunks,
  storedBytes,
  uniquePathBatches,
} from "../src/search-index.ts";
import { blobStructureSpec, type BlobStructure } from "../src/sections.ts";

const root = mkdtempSync(join(tmpdir(), "blob-structure-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repository = join(root, "repo");
Bun.spawnSync(["git", "init", "-q", repository]);
const blob = (text: string | Uint8Array) =>
  Bun.spawnSync(["git", "-C", repository, "hash-object", "-w", "--stdin"], {
    stdin: typeof text === "string" ? new TextEncoder().encode(text) : text,
  })
    .stdout.toString()
    .trim();
const entry = (path: string, text: string | Uint8Array): TreeEntry => ({
  mode: "100644",
  type: "blob",
  oid: blob(text),
  size: typeof text === "string" ? Buffer.byteLength(text) : text.byteLength,
  path,
});

/** Runs over one named store, recording the names of the spans it opens. */
const run = async <A, E>(
  effect: Effect.Effect<A, E, Computations.ComputationStore | Blobs.BlobStore>,
  name: string,
) => {
  const location = storeLocationIn(join(root, "stores", name));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  const spans: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      spans.push(options.name);
      return Tracer.nativeTracer.span(options);
    },
  });
  const value = await Effect.runPromise(
    effect.pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(layer),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  );
  return {
    value,
    outlineReads: spans.filter((span) => span === "harness.graph.outline")
      .length,
  };
};

/** The stored bytes under a blob's stable structure key, or undefined. */
const stableBytes = (item: TreeEntry, source: OutlineSource) =>
  Effect.map(
    storedBytes([blobStructureSpec(item.oid, item.path, source)]),
    ([stored]) =>
      stored === undefined ? undefined : new TextDecoder().decode(stored.bytes),
  );

const structureOf = (
  structures: ReadonlyMap<string, BlobStructure>,
  item: TreeEntry,
) => structures.get(structureKeyOf(item.path, item.oid));

/**
 * Stores a blob's chunks without its structure, as a store written before structures existed: the
 * pass stores no structure for a symlink entry, and the chunk key does not hold the mode.
 */
const chunksOnly = (items: ReadonlyArray<TreeEntry>, source: OutlineSource) =>
  blobChunks(
    repository,
    items.map((item) => ({ ...item, mode: "120000" })),
    source,
  );

const engine = outlineExecutable();
const graph = graphTestPrerequisite({
  available: existsSync(engine),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

const TS_BASE = `import { a } from "a";

export class Cache {
  get(key: string): number {
    return a(key);
  }
}
`;
const TS_HEAD = `import { a } from "a";

export class Cache {
  get(key: string, fallback: number): number {
    return a(key) ?? fallback;
  }
}

export function alpha(input: number): string {
  return String(input);
}
`;
const PY = `class Holder:
    def begin(self, x):
        return x

def top(a, b):
    return a
`;
const MD = "# Plan\nbody\n## Done when\n- it works\n";

test.skipIf(graph.skip)(
  "both sides of a modified file, neither chunked yet, get Graph chunks and Graph structure from one call",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const base = entry("src/cache.ts", TS_BASE);
    const head = entry("src/cache.ts", TS_HEAD);
    const { value, outlineReads } = await run(
      Effect.gen(function* () {
        const pass = yield* blobChunks(repository, [base, head], source);
        const read = yield* blobStructures(repository, [base, head], source);
        return { pass, read };
      }),
      "modified",
    );
    // One read per side: Graph refuses a batch that names a path twice.
    expect(outlineReads).toBe(2);
    for (const side of [base, head]) {
      const chunks = value.pass.chunks.get(`${side.path}\0${side.oid}`);
      expect(chunks?.capability).toBe("graph-symbols");
      expect(chunks?.fallback).toBeNull();
      expect(structureOf(value.read.structures, side)?.capability).toBe(
        "graph-symbols",
      );
    }
    expect(value.pass.structuresStored).toBe(2);
    expect(value.read.counts).toMatchObject({ stored: 2, computed: 0 });
  },
  60_000,
);

// Values computed at a96fc634 (before structures). A change to either sends every blob cold.
const CHUNK_SPEC_AT_A96FC634 = (
  blobOid: string,
  path: string,
  source: OutlineSource,
) => ({
  op: "harness.blob-chunks",
  opVersion: 1,
  inputs: { blob: `git-blob:${blobOid}` },
  config: {
    recipe: "neuve-graph-chunk-v6",
    source: source.key,
    sourceBinding: "graph-source-bound-v1",
    bounds: { id: "neuve-index-bounds-v1", maxFileBytes: 1048576 },
    path,
  },
});
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const storedChunk = (spec: Computations.ComputationSpec) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const key = Computations.computationKey(spec).key;
    const row = (yield* store.lookupMany([key])).get(key);
    if (row === undefined) return { key, sha: undefined };
    const read = (yield* blobs.getMany([row.outputHash])).get(row.outputHash);
    return {
      key,
      sha:
        read === undefined || read._tag === "Pruned"
          ? undefined
          : sha256(read.bytes),
    };
  });

test("a blob's chunk key and stored chunk bytes are as before structures", async () => {
  // A fixed absent engine: Markdown chunks take the stable key without Graph, so the key is constant.
  const absent = "/nonexistent/neuve-structure-test-engine";
  const source: OutlineSource = {
    executable: absent,
    key: { unavailable: absent },
  };
  const plan = entry("plan.md", MD);
  expect(plan.oid).toBe("97b0efb5f46c03386c7add470f7063447e042ce3");
  const { value } = await run(
    Effect.gen(function* () {
      yield* blobChunks(repository, [plan], source);
      return yield* storedChunk(
        CHUNK_SPEC_AT_A96FC634(plan.oid, plan.path, source),
      );
    }),
    "chunk-identity-markdown",
  );
  expect(value).toEqual({
    key: "cb2d8fd200eed1ae68e6bd989c9a164998a41c8445415e24e494fab69f33cb1c",
    sha: "13046568bfc3a3388e7ed7ec42f948e4b149f260e1a2c030a2ee5e0ab95beaa3",
  });
});

test.skipIf(graph.skip)(
  "a Graph-chunked blob's stored chunk bytes are as before structures",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const cache = entry(
      "src/cache.ts",
      'import { a } from "a";\n\nexport class Cache {\n  get(key: string): number {\n    return a(key);\n  }\n}\n\nexport function alpha(input: number): string {\n  return String(input);\n}\n',
    );
    const { value } = await run(
      Effect.gen(function* () {
        yield* blobChunks(repository, [cache], source);
        return yield* storedChunk(
          CHUNK_SPEC_AT_A96FC634(cache.oid, cache.path, source),
        );
      }),
      "chunk-identity-graph",
    );
    // The key is the a96fc634 spec with this engine's identity; the bytes are this engine's output
    // at Graph 8244f45, which the submodule pins.
    expect(value.sha).toBe(
      "6eba54e1100e1a99959ad4f4c7c493f604b0ceefdc7bf7494dc3b3d15b4e24ec",
    );
  },
  60_000,
);

test.skipIf(graph.skip)(
  "after the pass, the reader answers from the store and reads Graph no more",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const items = [entry("pass/cache.ts", TS_HEAD), entry("pass/plan.md", MD)];
    await run(blobChunks(repository, items, source), "after-pass");
    const { value, outlineReads } = await run(
      blobStructures(repository, items, source),
      "after-pass",
    );
    expect(outlineReads).toBe(0);
    expect(value.counts).toMatchObject({
      asked: 2,
      stored: 2,
      computed: 0,
      outlineBatches: 0,
      outlineFiles: 0,
    });
  },
  60_000,
);

test.skipIf(graph.skip)(
  "a blob whose chunks are stored but whose structure is not costs one outline observation, then none",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const items = [
      entry("legacy/cache.ts", TS_HEAD),
      entry("legacy/holder.py", PY),
      entry("legacy/plan.md", MD),
    ];
    await run(chunksOnly(items, source), "legacy");
    const first = await run(
      blobStructures(repository, items, source),
      "legacy",
    );
    // Markdown needs no Graph: two files in one read.
    expect(first.outlineReads).toBe(1);
    expect(first.value.counts).toMatchObject({
      stored: 0,
      computed: 3,
      outlineBatches: 1,
      outlineFiles: 2,
    });
    const second = await run(
      blobStructures(repository, items, source),
      "legacy",
    );
    expect(second.outlineReads).toBe(0);
    expect(second.value.counts).toMatchObject({ stored: 3, computed: 0 });
  },
  60_000,
);

test.skipIf(graph.skip)(
  "the pass and the reader's fallback store the same bytes for a blob",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const items = [
      entry("same/cache.ts", TS_HEAD),
      entry("same/holder.py", PY),
      entry("same/plan.md", MD),
    ];
    // Different batches on each side: Graph's view of a file must not depend on its neighbours.
    const extra = entry("same/extra.ts", "export const extra = 1;\n");
    const pass = await run(
      Effect.gen(function* () {
        yield* blobChunks(repository, [...items, extra], source);
        return yield* Effect.forEach(items, (item) =>
          stableBytes(item, source),
        );
      }),
      "producers-pass",
    );
    const fallback = await run(
      Effect.gen(function* () {
        yield* chunksOnly(items, source);
        yield* blobStructures(repository, items, source);
        return yield* Effect.forEach(items, (item) =>
          stableBytes(item, source),
        );
      }),
      "producers-fallback",
    );
    expect(pass.value.every((bytes) => bytes !== undefined)).toBe(true);
    expect(fallback.value).toEqual(pass.value);
  },
  60_000,
);

test.skipIf(graph.skip)(
  "while Graph is unavailable a structure says so, keeps off the stable key, and is stored once Graph is back",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const code = entry("down/cache.ts", TS_HEAD);
    const plan = entry("down/plan.md", MD);
    const previous = process.env.TMPDIR;
    let down;
    try {
      process.env.TMPDIR = join(root, "missing-temporary-parent");
      down = await run(
        Effect.gen(function* () {
          const pass = yield* blobChunks(repository, [code, plan], source);
          const read = yield* blobStructures(repository, [code, plan], source);
          return {
            pass,
            read,
            code: yield* stableBytes(code, source),
            plan: yield* stableBytes(plan, source),
          };
        }),
        "unavailable",
      );
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(structureOf(down.value.read.structures, code)).toMatchObject({
      capability: "none",
      reason: "capability-unavailable",
    });
    expect(down.value.code).toBeUndefined();
    expect(down.value.pass.structuresRetryable).toBe(1);
    // Markdown needs no Graph: its structure is kept while Graph is unavailable.
    expect(structureOf(down.value.read.structures, plan)?.capability).toBe(
      "markdown-sections",
    );
    expect(down.value.plan).toBeDefined();
    expect(down.value.read.counts.none).toEqual({
      "capability-unavailable": 1,
    });
    // A reuse of the retryable key is counted as retryable, never as a stored structure.
    expect(down.value.read.counts).toMatchObject({
      stored: 1,
      computed: 0,
      joined: 0,
      retryable: 1,
    });
    const up = await run(
      Effect.gen(function* () {
        const read = yield* blobStructures(repository, [code], source);
        return { read, code: yield* stableBytes(code, source) };
      }),
      "unavailable",
    );
    expect(up.outlineReads).toBe(1);
    expect(structureOf(up.value.read.structures, code)?.capability).toBe(
      "graph-symbols",
    );
    expect(up.value.code).toBeDefined();
  },
  60_000,
);

test.skipIf(graph.skip)(
  "a changed symbol keeps its kind, signature and container, in TypeScript and Python",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const code = entry("facts/cache.ts", TS_HEAD);
    const python = entry("facts/holder.py", PY);
    const { value } = await run(
      Effect.gen(function* () {
        yield* blobChunks(repository, [code, python], source);
        return yield* blobStructures(repository, [code, python], source);
      }),
      "facts",
    );
    const ts = structureOf(value.structures, code);
    expect(ts?.language).toBe("TypeScript");
    const cacheSpan = ts?.spans.find((span) => span.name === "Cache");
    // The span opens after the import block and ends with the class.
    expect(cacheSpan).toMatchObject({
      start: 2,
      end: 7,
      kind: "declaration",
      nodeType: "export_statement",
      lines: 6,
    });
    // A class kept whole keeps its members' symbols.
    expect(cacheSpan?.symbols).toEqual([
      {
        name: "Cache",
        kind: "class",
        qualifiedName: "Cache",
        signature: "class Cache",
        container: null,
        startLine: 3,
        endLine: 7,
      },
      {
        name: "get",
        kind: "method",
        qualifiedName: "Cache.get",
        signature: "get(key: string, fallback: number): number",
        container: "Cache",
        startLine: 4,
        endLine: 6,
      },
    ]);
    const py = structureOf(value.structures, python);
    expect(py?.language).toBe("Python");
    expect(py?.spans.flatMap((span) => span.symbols)).toEqual([
      {
        name: "Holder",
        kind: "class",
        qualifiedName: "Holder",
        signature: "class Holder",
        container: null,
        startLine: 1,
        endLine: 3,
      },
      {
        name: "begin",
        kind: "method",
        qualifiedName: "Holder.begin",
        signature: "def begin(self, x)",
        container: "Holder",
        startLine: 2,
        endLine: 3,
      },
      {
        name: "top",
        kind: "function",
        qualifiedName: "top",
        signature: "def top(a, b)",
        container: null,
        startLine: 5,
        endLine: 6,
      },
    ]);
  },
  60_000,
);

test.skipIf(graph.skip)(
  "every way a blob has no structure is named, and only stable ones are stored",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const cases: ReadonlyArray<[TreeEntry, string, boolean]> = [
      [entry("none/data.bin", new Uint8Array([0, 1, 2, 0])), "binary", true],
      [entry("none/notes.unknown", "alpha\n"), "unsupported-language", true],
      [
        entry("none/broken.ts", "export function broken( { return \n"),
        "parse-error",
        true,
      ],
      [
        entry("none/a_windows.go", "package a\nfunc alpha() {}\n"),
        "outline-unavailable",
        true,
      ],
      [
        entry(
          "none/data.json",
          JSON.stringify({ value: "x".repeat(10000) }) + "\n",
        ),
        "source-not-parsed",
        true,
      ],
      [
        {
          ...entry("none/large.ts", "export const large = 1;\n"),
          size: 2_000_000,
        },
        "over-size",
        false,
      ],
      [
        { ...entry("none/link.ts", "target.ts"), mode: "120000" },
        "symlink",
        false,
      ],
      [
        {
          mode: "160000",
          type: "commit",
          oid: "1".repeat(40),
          size: null,
          path: "none/module",
        },
        "submodule",
        false,
      ],
      [
        {
          mode: "040000",
          type: "tree",
          oid: "2".repeat(40),
          size: null,
          path: "none/folder",
        },
        "not-a-blob",
        false,
      ],
      [
        {
          mode: "100644",
          type: "blob",
          oid: "3".repeat(40),
          size: 10,
          path: "none/gone.ts",
        },
        "unreadable",
        false,
      ],
    ];
    const items = cases.map(([item]) => item);
    const { value } = await run(
      Effect.gen(function* () {
        const read = yield* blobStructures(repository, items, source);
        const stable = yield* Effect.forEach(items, (item) =>
          stableBytes(item, source),
        );
        return { read, stable };
      }),
      "reasons",
    );
    cases.forEach(([item, reason, kept], index) => {
      expect([
        item.path,
        structureOf(value.read.structures, item)?.reason,
      ]).toEqual([item.path, reason]);
      expect([item.path, value.stable[index] !== undefined]).toEqual([
        item.path,
        kept,
      ]);
    });
    expect(value.read.counts.none).toEqual(
      Object.fromEntries(cases.map(([, reason]) => [reason, 1])),
    );
  },
  60_000,
);

// Graph also refuses a batch holding a file and a path under it: a range that turns a file into a
// folder put both in one read, and every file in it fell back as if Graph were unavailable.
test("outline batches never hold a path twice, or a path and one under it, and batch as before otherwise", () => {
  const paths = (batches: ReadonlyArray<ReadonlyArray<string>>) =>
    batches.map((batch) => [...batch]);
  expect(
    paths(
      uniquePathBatches(["a.ts", "b.ts", "a.ts", "c.ts", "a.ts"], (p) => p),
    ),
  ).toEqual([["a.ts", "b.ts", "c.ts"], ["a.ts"], ["a.ts"]]);
  expect(
    paths(
      uniquePathBatches(
        ["lib", "lib/index.ts", "other.ts", "lib/deep/x.ts", "lib"],
        (p) => p,
      ),
    ),
  ).toEqual([
    ["lib", "other.ts"],
    ["lib/index.ts", "lib/deep/x.ts"],
    // The second `lib` cannot join paths under it.
    ["lib"],
  ]);
  // The descendant first: its ancestor waits for the next batch.
  expect(paths(uniquePathBatches(["lib/index.ts", "lib"], (p) => p))).toEqual([
    ["lib/index.ts"],
    ["lib"],
  ]);
});

test.skipIf(graph.skip)(
  "a file and the folder that replaced it, in one pass and in one fallback, all get Graph's answer",
  async () => {
    graph.require();
    const source = captureOutlineSource();
    const items = [
      entry("lib", "export const lib = 1;\n"),
      entry("lib/index.ts", TS_HEAD),
      entry("other.ts", "export const other = 2;\n"),
    ];
    const pass = await run(
      Effect.gen(function* () {
        yield* blobChunks(repository, items, source);
        return yield* blobStructures(repository, items, source);
      }),
      "folder-pass",
    );
    const fallback = await run(
      Effect.gen(function* () {
        yield* chunksOnly(items, source);
        return yield* blobStructures(repository, items, source);
      }),
      "folder-fallback",
    );
    for (const { value } of [pass, fallback]) {
      expect(structureOf(value.structures, items[1]!)?.capability).toBe(
        "graph-symbols",
      );
      expect(structureOf(value.structures, items[2]!)?.capability).toBe(
        "graph-symbols",
      );
      expect(value.counts.none["capability-unavailable"]).toBeUndefined();
    }
    expect(fallback.value.counts.outlineBatches).toBe(2);
  },
  60_000,
);

// Without Graph: a fixed absent engine, so these hold wherever the tests run.
const absentSource = (): OutlineSource => {
  const absent = "/nonexistent/neuve-structure-test-engine";
  return { executable: absent, key: { unavailable: absent } };
};

// The key of a structure the pass owes after another run stored the chunks must come from what the
// blob is: a binary blob is never retryable, so it must not wait under a retryable key.
test("a binary blob whose chunks another run stored takes the stable structure key", async () => {
  const source = absentSource();
  const binary = entry("reuse/data.bin", new Uint8Array([0, 7, 0, 7]));
  const { value } = await run(
    Effect.gen(function* () {
      // Graph is unavailable, so the chunks take their retryable key; the second pass reuses them.
      yield* chunksOnly([binary], source);
      const pass = yield* blobChunks(repository, [binary], source);
      return { pass, stable: yield* stableBytes(binary, source) };
    }),
    "binary-reuse",
  );
  expect(value.pass.reused).toBe(1);
  expect(value.pass.structuresStored).toBe(1);
  expect(value.pass.structuresRetryable).toBe(0);
  expect(JSON.parse(value.stable ?? "null")).toMatchObject({
    capability: "none",
    reason: "binary",
  });
});

// One over-size rule for both producers: the blob's byte length, also where the entry's size is
// unknown (the hunks pass may not know it).
test("a blob over the size bound has no stored structure, in the pass and the reader, with or without its size", async () => {
  const source = absentSource();
  const large = entry("big/large.txt", "x".repeat(1_048_576) + "\n");
  const unsized = { ...large, size: null };
  const { value } = await run(
    Effect.gen(function* () {
      const pass = yield* blobChunks(repository, [unsized], source);
      const afterPass = yield* stableBytes(unsized, source);
      const read = yield* blobStructures(repository, [unsized], source);
      const sized = yield* blobStructures(repository, [large], source);
      return {
        pass,
        afterPass,
        read,
        sized,
        stable: yield* stableBytes(unsized, source),
      };
    }),
    "over-size",
  );
  expect(value.pass.structuresStored + value.pass.structuresRetryable).toBe(0);
  expect(value.afterPass).toBeUndefined();
  for (const read of [value.read, value.sized])
    expect(structureOf(read.structures, large)?.reason).toBe("over-size");
  expect(value.stable).toBeUndefined();
});

/** The git commands a piece of work starts, with their arguments. */
const gitCommands = async <A>(work: () => Promise<A>) => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const value = await work();
    const commands = spawn.mock.calls
      .map(([command]) => (Array.isArray(command) ? command : []))
      .filter(
        (command) => command[0] === "git" || command[0] === Bun.which("git"),
      )
      .map((command) => command.join(" "));
    return { value, commands };
  } finally {
    spawn.mockRestore();
  }
};

// The common path must stay one store lookup: a structure found stored starts no git process, even
// where the caller (the unit fill) knows no blob size.
test("stored structures cost no git process, with sizes unknown", async () => {
  const source = absentSource();
  const items = [
    entry("hits/plan.md", MD),
    entry("hits/notes.md", "# Notes\nmore\n"),
    entry("hits/data.bin", new Uint8Array([0, 9, 0, 9])),
  ];
  await run(blobChunks(repository, items, source), "hits");
  const { value, commands } = await gitCommands(() =>
    run(
      blobStructures(
        repository,
        items.map((item) => ({ ...item, size: null })),
        source,
      ),
      "hits",
    ),
  );
  expect(commands).toEqual([]);
  expect(value.value.counts).toMatchObject({ asked: 3, stored: 3 });
});

// A caller without sizes put every miss in one read group, unbounded exactly when a cold store
// misses for every changed blob. Grouping past the 16 MiB bound would need a fixture over 16 MiB,
// so this holds what the bound rests on: a miss's size is resolved before its content is read,
// and a miss over the size bound is answered without reading it.
test("misses with sizes unknown are sized first, and an over-size miss is never read", async () => {
  const source = absentSource();
  const large = {
    ...entry("misses/large.md", "x".repeat(1_048_576) + "\n"),
    size: null,
  };
  const small = { ...entry("misses/small.md", "# Small\nbody\n"), size: null };
  const over = await gitCommands(() =>
    run(blobStructures(repository, [large], source), "misses"),
  );
  // One size check, no content read.
  const overReads = over.commands.filter((command) =>
    command.includes(" cat-file "),
  );
  expect(overReads).toHaveLength(1);
  expect(overReads[0]).toContain("cat-file --batch-check");
  expect(structureOf(over.value.value.structures, large)?.reason).toBe(
    "over-size",
  );
  const read = await gitCommands(() =>
    run(blobStructures(repository, [small], source), "misses"),
  );
  // One size check, then one content read.
  expect(
    read.commands.filter((command) => command.includes(" cat-file ")),
  ).toEqual([
    expect.stringContaining("cat-file --batch-check"),
    expect.stringMatching(/ cat-file --batch$/),
  ]);
  expect(structureOf(read.value.value.structures, small)?.capability).toBe(
    "markdown-sections",
  );
});

test.skipIf(graph.skip)(
  "a path Graph refuses is kept out of the outline read: its batch still gets Graph structure and chunks, and it gets the stable outline-unavailable under its stable keys",
  async () => {
    // Why: Graph refuses a whole read that names one invalid path, so before this every file
    // sharing a batch with it fell back to retryable "Graph unavailable" and was read again on
    // every call. A path with a backslash is one Git stores and Graph refuses.
    graph.require();
    const source = captureOutlineSource();
    const good = entry("src/kept.ts", TS_BASE);
    const refused = entry("src/back\\slash.ts", TS_HEAD);
    const { value, outlineReads } = await run(
      Effect.gen(function* () {
        const pass = yield* blobChunks(repository, [good, refused], source);
        const again = yield* blobChunks(repository, [good, refused], source);
        const read = yield* blobStructures(repository, [good, refused], source);
        const stable = {
          good: yield* stableBytes(good, source),
          refused: yield* stableBytes(refused, source),
        };
        const chunk = yield* storedChunk(
          CHUNK_SPEC_AT_A96FC634(refused.oid, refused.path, source),
        );
        return { pass, again, read, stable, chunk };
      }),
      "refused-path",
    );
    // One read, holding only the path Graph accepts; the second pass and the reader read nothing.
    expect(outlineReads).toBe(1);
    const chunks = (item: TreeEntry) =>
      value.pass.chunks.get(`${item.path}\0${item.oid}`);
    expect([chunks(good)?.capability, chunks(good)?.fallback]).toEqual([
      "graph-symbols",
      null,
    ]);
    expect(chunks(refused)?.fallback).toBe("outline-unavailable");
    expect(value.pass.structuresStored).toBe(2);
    expect(value.pass.structuresRetryable).toBe(0);
    expect(value.again.reused).toBe(2);
    expect(structureOf(value.read.structures, good)?.capability).toBe(
      "graph-symbols",
    );
    expect(structureOf(value.read.structures, refused)).toMatchObject({
      capability: "none",
      reason: "outline-unavailable",
    });
    expect(value.read.counts).toMatchObject({ stored: 2, retryable: 0 });
    expect(value.stable.good).toBeDefined();
    expect(JSON.parse(value.stable.refused!)).toMatchObject({
      reason: "outline-unavailable",
    });
    expect(value.chunk.sha).toBeDefined();
  },
  60_000,
);
