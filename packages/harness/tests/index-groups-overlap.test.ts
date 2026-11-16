// Why: a cold tree index read its size groups one after another, so each group's outline read
// waited for the previous group's chunk computations. Groups now overlap, at most two at once. These
// tests hold `blobChunks` to what it was: the same index and keys, a failure that fails the whole
// build and stops every other group, a degraded group that is never stored or kept as good, and,
// under an inherited CPU grant, never more CPU than the grant, with a group that runs alone given
// all of it, also for an outline read that asks for permits after its group was stopped.
import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import * as GraphClient from "@neuve/graph-client";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import { readOutlines, type OutlineSource } from "../src/graph-outline.ts";
import {
  blobChunks,
  forgetDegradedIndexes,
  treeIndex,
  type TreeIndex,
} from "../src/search-index.ts";

const root = mkdtempSync(join(tmpdir(), "index-groups-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** No Graph at this fixed path: every outline is unavailable, and every key is the same each run. */
const source: OutlineSource = {
  executable: "/nonexistent/neuve-index-groups-graph",
  key: { unavailable: "/nonexistent/neuve-index-groups-graph" },
};

type Service = Computations.ComputationStore["Service"];
type Cpu = CpuWork["Service"];
const priority = {
  class: "interactive",
  position: "understand",
  stage: 0,
} as const;
/** The budget's own pool: each outline read and chunk batch acquires its own permits. */
const owned = (): Cpu => ({
  budget: new Scheduler(4),
  priority,
  inherited: false,
});
/** A child covered by its parent's grant of `permits` (prepare-commit, or floor mode with 1). */
const inheritedGrant = (permits: number): Cpu => ({
  budget: new Scheduler(permits),
  priority,
  inherited: true,
  permits,
});
/** The effect over a fresh store named `name`, with the store wrapped and the CPU work given. */
const provided = <A, E>(
  effect: Effect.Effect<A, E, Computations.ComputationStore | Blobs.BlobStore>,
  name: string,
  wrap: (store: Service) => Service,
  cpu: Cpu,
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
  return Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    return yield* effect.pipe(
      Effect.provideService(Computations.ComputationStore, wrap(store)),
    );
  }).pipe(
    Effect.provideService(CpuWork, cpu),
    Effect.provideService(CodeWork, undefined),
    Effect.provide(layer),
  );
};
const run = <A, E>(
  effect: Effect.Effect<A, E, Computations.ComputationStore | Blobs.BlobStore>,
  name: string,
  wrap: (store: Service) => Service = (store) => store,
  cpu: Cpu = owned(),
) => Effect.runPromise(provided(effect, name, wrap, cpu));

/** Each test's outline publications in a fresh budget directory, so no test reads another's. */
const freshBudget = (name: string) => {
  const prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = join(root, `budget-${name}`);
  return () => {
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
  };
};

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** One digest of an index's content, walking maps, sets and typed arrays in their own order. */
const indexDigest = ({
  source: _source,
  buildMs: _buildMs,
  ...index
}: TreeIndex) => {
  const hash = createHash("sha256");
  const feed = (value: unknown): void => {
    if (value instanceof Map) {
      hash.update(`M${value.size}[`);
      for (const [key, item] of value) {
        feed(key);
        feed(item);
      }
      hash.update("]");
    } else if (value instanceof Set) {
      hash.update(`S${value.size}[`);
      for (const item of value) feed(item);
      hash.update("]");
    } else if (ArrayBuffer.isView(value)) {
      hash.update(`T${(value as Uint32Array).length}[`);
      for (const item of value as Uint32Array) hash.update(`${item},`);
      hash.update("]");
    } else if (Array.isArray(value)) {
      hash.update(`A${value.length}[`);
      for (const item of value) feed(item);
      hash.update("]");
    } else if (value !== null && typeof value === "object") {
      hash.update("O{");
      for (const [key, item] of Object.entries(value)) {
        hash.update(JSON.stringify(key));
        feed(item);
      }
      hash.update("}");
    } else hash.update(`${JSON.stringify(value) ?? "undefined"};`);
  };
  feed(index);
  return hash.digest("hex");
};

/** Deterministic text: lines of words from a small vocabulary, about `bytes` long. */
const text = (seed: number, bytes: number, heading: boolean) => {
  const vocabulary = Array.from(
    { length: 300 },
    (_, n) => `word${n.toString(36)}${n % 7 === 0 ? "Camel" : ""}`,
  );
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31);
  const lines: Array<string> = [];
  let length = 0;
  for (let line = 0; length < bytes; line++) {
    const words = Array.from(
      { length: 8 },
      () => vocabulary[next() % vocabulary.length],
    );
    const body =
      heading && line % 200 === 0
        ? `# Section ${line}\n`
        : `${words.join(" ")}\n`;
    lines.push(body);
    length += body.length;
  }
  return lines.join("").slice(0, bytes);
};

// Why: the identity pin was a constant taken on `b20e2341`, a digest of the whole index, so it
// moved whenever an unrelated part of the index did (the declarations gained `undecided` and
// `asked`). The serial build is now taken in the test: under an inherited grant of one permit the
// groups run one at a time (`cpuConcurrency` gives 1), in group order, which is the serial build.
test("a tree index over several size groups is the one the serial build gave, and stays degraded", async () => {
  const repository = join(root, "identity-repo");
  mkdirSync(repository);
  const git = (args: Array<string>, input?: string | Uint8Array) => {
    const child = Bun.spawnSync(["git", "-C", repository, ...args], {
      ...(input === undefined
        ? {}
        : {
            stdin:
              typeof input === "string"
                ? new TextEncoder().encode(input)
                : input,
          }),
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git(["init", "-q"]);
  const lines: Array<string> = [];
  const add = (path: string, content: string | Uint8Array) =>
    lines.push(
      `100644 blob ${git(["hash-object", "-w", "--stdin"], content)}\t${path}`,
    );
  // Sixteen files of 1,000,000 bytes fill a 16 MiB read group: Markdown first (healthy without
  // Graph), then TypeScript (degraded: its outline is unavailable), then a mixed last group.
  for (let n = 0; n < 16; n++)
    add(
      `a-docs/${String(n).padStart(2, "0")}.md`,
      text(n + 1, 1_000_000, true),
    );
  for (let n = 0; n < 16; n++)
    add(
      `b-code/${String(n).padStart(2, "0")}.ts`,
      text(n + 101, 1_000_000, false),
    );
  add("c-mixed/big.md", text(201, 1_000_000, true));
  add("c-mixed/big.ts", text(202, 1_000_000, false));
  add("c-mixed/copy-one.ts", "export const shared = 1;\n");
  add("c-mixed/copy-two.ts", "export const shared = 1;\n");
  add("c-mixed/empty.md", "");
  add("c-mixed/long.md", `# Long\n${"x".repeat(40_000)}\nshort tail\n`);
  add("c-mixed/data.bin", new Uint8Array([1, 0, 2, 0, 3]));
  git(["update-index", "--add", "--index-info"], `${lines.join("\n")}\n`);
  const tree = git(["write-tree"]);
  /** A cold build in a fresh store and budget directory: its index and its keys' digests. */
  const build = async (name: string, cpu: Cpu) => {
    const restore = freshBudget(name);
    try {
      const keys: Array<string> = [];
      const recording = (store: Service): Service => ({
        ...store,
        run: (spec, compute) =>
          Effect.tap(store.run(spec, compute), (result) =>
            Effect.sync(() => {
              keys.push(
                `${spec.op}\0${result.computation.key}\0${sha256(result.output)}`,
              );
            }),
          ),
      });
      const built = await run(
        treeIndex(repository, tree, source),
        name,
        recording,
        cpu,
      );
      expect(built.cached).toBe(false);
      const digests = {
        index: indexDigest(built.index),
        keys: sha256(keys.sort().join("\n")),
      };
      console.info(`index-groups ${name} digests ${JSON.stringify(digests)}`);
      return { index: built.index, digests };
    } finally {
      restore();
    }
  };
  const serial = await build("identity-serial", inheritedGrant(1));
  // The serial index is degraded, so this process holds it; drop it so the next build is cold.
  forgetDegradedIndexes();
  const restore = freshBudget("identity");
  try {
    const built = await build("identity", owned());
    expect(built.index.files).toBe(39);
    expect(built.digests).toEqual(serial.digests);
    // Degraded (the TypeScript chunks' fallback is retryable): kept in this process only, and
    // rebuilt once forgotten, to the same index.
    expect(
      built.index.chunks.some(
        (chunk) => chunk.fallback === "capability-unavailable",
      ),
    ).toBe(true);
    const again = await run(treeIndex(repository, tree, source), "identity");
    expect(again.cached).toBe(true);
    forgetDegradedIndexes();
    const rebuilt = await run(treeIndex(repository, tree, source), "identity");
    expect(rebuilt.cached).toBe(false);
    // Only its counts differ: the healthy blobs are reused, the degraded ones chunked again.
    expect(rebuilt.index.blobsReused).toBeGreaterThan(0);
    expect(
      indexDigest({
        ...rebuilt.index,
        blobsComputed: built.index.blobsComputed,
        blobsReused: built.index.blobsReused,
        chunksComputed: built.index.chunksComputed,
        chunksReused: built.index.chunksReused,
      }),
    ).toBe(built.digests.index);
  } finally {
    restore();
  }
}, 300_000);

/** Entries that fill `groups` read groups by their declared size, with tiny contents. */
const groupedInput = (groups: ReadonlyArray<"md" | "ts">) => {
  const contents = new Map<string, Uint8Array>();
  const entries = groups.flatMap((extension, group) =>
    Array.from({ length: 16 }, (_, n) => {
      const bytes = new TextEncoder().encode(
        extension === "md"
          ? `# Group ${group} file ${n}\nbody ${group} ${n}\n`
          : `export const g${group}n${n} = ${n};\n`,
      );
      const oid = createHash("sha1").update(bytes).digest("hex");
      contents.set(oid, bytes);
      // The declared size, at the index's file bound, puts sixteen files in each read group.
      return {
        mode: "100644",
        type: "blob",
        oid,
        size: 1_048_576,
        path: `g${group + 1}/${String(n).padStart(2, "0")}.${extension}`,
      };
    }),
  );
  return { entries, contents };
};
const groupOf = (path: string) => Number(/^g(\d+)\//.exec(path)?.[1] ?? 0);

/**
 * A fake Graph whose every read is held until the test releases its group, or until the read is
 * aborted. A released read is answered as unavailable, as when Graph is absent.
 */
const heldGraph = () => {
  const reads: Array<{ group: number; aborted: boolean; done: boolean }> = [];
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const started = new Map<number, PromiseWithResolvers<void>>();
  const gate = (group: number) => {
    let held = gates.get(group);
    if (held === undefined) gates.set(group, (held = Promise.withResolvers()));
    return held;
  };
  const start = (group: number) => {
    let held = started.get(group);
    if (held === undefined)
      started.set(group, (held = Promise.withResolvers()));
    return held;
  };
  let active = 0;
  let peak = 0;
  const spy = spyOn(GraphClient, "readGraphSymbols").mockImplementation(
    async (input) => {
      const group = groupOf(input.files[0]?.path ?? "");
      const read = { group, aborted: false, done: false };
      reads.push(read);
      active++;
      peak = Math.max(peak, active);
      start(group).resolve();
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            read.aborted = true;
            reject(new Error("fixture read aborted"));
          };
          if (input.signal?.aborted) return abort();
          input.signal?.addEventListener("abort", abort, { once: true });
          void gate(group).promise.then(resolve);
        });
        throw new GraphClient.GraphSymbolsError({
          reason: "executable-unavailable",
          message: "Graph executable unavailable.",
        });
      } finally {
        active--;
        read.done = true;
      }
    },
  );
  return {
    reads,
    peak: () => peak,
    release: (group: number) => gate(group).resolve(),
    started: (group: number) => start(group).promise,
    restore: () => spy.mockRestore(),
  };
};

/** Resolves with the promise, or rejects with `what` when it takes longer than `ms`. */
const within = <A>(promise: Promise<A>, what: string, ms = 5_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${what}`)), ms),
    ),
  ]);

/** Chunk computations by group: how many started and ended, and a gate per group. */
const computations = () => {
  const counts = new Map<number, { started: number; ended: number }>();
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const ended = new Map<number, PromiseWithResolvers<void>>();
  const failing = new Set<number>();
  const count = (group: number) => {
    let held = counts.get(group);
    if (held === undefined)
      counts.set(group, (held = { started: 0, ended: 0 }));
    return held;
  };
  const allEnded = (group: number) => {
    let held = ended.get(group);
    if (held === undefined) ended.set(group, (held = Promise.withResolvers()));
    return held;
  };
  let calls = 0;
  const wrap = (store: Service): Service => ({
    ...store,
    run: (spec, compute) => {
      if (spec.op !== "harness.blob-chunks") return store.run(spec, compute);
      const path = String((spec.config as { path?: unknown }).path ?? "");
      const group = groupOf(path);
      return Effect.gen(function* () {
        calls++;
        count(group).started++;
        const gate = gates.get(group);
        if (gate !== undefined) yield* Effect.promise(() => gate.promise);
        if (failing.has(group))
          return yield* Effect.fail(
            new Computations.SharedAttemptFailed({
              key: "fixture",
              attemptId: "fixture",
              tag: "Fixture",
              message: `group ${group} failed`,
            }),
          );
        return yield* store.run(spec, compute);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const held = count(group);
            held.ended++;
            if (held.ended === 16) allEnded(group).resolve();
          }),
        ),
      );
    },
  });
  return {
    wrap,
    calls: () => calls,
    count,
    ended: (group: number) => allEnded(group).promise,
    hold: (group: number) => {
      const gate = Promise.withResolvers<void>();
      gates.set(group, gate);
      return () => gate.resolve();
    },
    fail: (group: number) => failing.add(group),
  };
};

// Under the budget's own pool, where each read and chunk batch acquires its own permits.
test("a second group's outline read starts while the first group's chunks are computed, two groups at most", async () => {
  const restore = freshBudget("overlap");
  const graph = heldGraph();
  const work = computations();
  try {
    const { entries, contents } = groupedInput(["md", "ts", "md"]);
    const releaseFirst = work.hold(1);
    const pending = run(
      blobChunks(root, entries, source, contents),
      "overlap",
      work.wrap,
    );
    await within(graph.started(1), "the first group's outline read");
    graph.release(1);
    // The first group's chunk computations are held: its next group's read must not wait for them.
    await within(
      graph.started(2),
      "the second group's read before the first group's chunks end",
    );
    expect(work.count(1).ended).toBe(0);
    // Two groups are held: the first computing, the second reading. A third waits for one to end.
    await Bun.sleep(300);
    expect(graph.reads.map((read) => read.group).sort()).toEqual([1, 2]);
    releaseFirst();
    await within(work.ended(1), "the first group's chunks");
    await within(
      graph.started(3),
      "the third group's read once the first ended",
    );
    // The degraded second group ends last: the healthy third group finishes before it.
    graph.release(3);
    await within(work.ended(3), "the third group's chunks");
    expect(work.count(2).started).toBe(0);
    graph.release(2);
    const result = await within(pending, "the build");
    expect(graph.peak()).toBe(2);
    // Joined in group order, whatever order the groups ended in.
    const order = [...result.chunks.keys()].map((key) => groupOf(key));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.chunks.size).toBe(48);
    expect(result.computed).toBe(48);
    for (const [key, chunks] of result.chunks)
      expect(chunks.fallback).toBe(
        groupOf(key) === 2 ? "capability-unavailable" : null,
      );
    // The degraded group was not stored as good: a second pass reuses the healthy groups and asks
    // Graph again for the degraded one only.
    const before = graph.reads.length;
    const second = await within(
      run(blobChunks(root, entries, source, contents), "overlap"),
      "the second pass",
    );
    expect(graph.reads.slice(before).map((read) => read.group)).toEqual([2]);
    expect(second.reused).toBe(48);
    expect(second.computed).toBe(0);
  } finally {
    graph.restore();
    restore();
  }
}, 30_000);

test("a failure in one group fails the build and stops the group overlapping it", async () => {
  const restore = freshBudget("failure");
  const graph = heldGraph();
  const work = computations();
  try {
    const { entries, contents } = groupedInput(["md", "md", "md"]);
    const releaseFirst = work.hold(1);
    work.fail(1);
    const pending = run(
      Effect.exit(blobChunks(root, entries, source, contents)),
      "failure",
      work.wrap,
    );
    await within(graph.started(1), "the first group's outline read");
    graph.release(1);
    await within(
      graph.started(2),
      "the second group's read while the first computes",
    );
    releaseFirst();
    const exit = await within(pending, "the failed build");
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(Computations.SharedAttemptFailed);
      if (error instanceof Computations.SharedAttemptFailed)
        expect(error.message).toBe("group 1 failed");
    }
    // The overlapping group's held read was aborted with the build, and no group started after.
    await within(
      (async () => {
        while (!graph.reads.every((read) => read.done)) await Bun.sleep(10);
      })(),
      "the second group's read to stop",
    );
    expect(
      graph.reads
        .map(({ group, aborted }) => ({ group, aborted }))
        .sort((a, b) => a.group - b.group),
    ).toEqual([
      { group: 1, aborted: false },
      { group: 2, aborted: true },
    ]);
    const calls = work.calls();
    await Bun.sleep(300);
    expect(work.calls()).toBe(calls);
    expect(work.count(2).started).toBe(0);
    expect(work.count(3).started).toBe(0);
  } finally {
    graph.restore();
    restore();
  }
}, 30_000);

/**
 * A fake Graph that spends what the outline read's grant gives it: it runs through the real
 * `execute` (the read's `cpuPool`), holds the permits it was given for a while, then answers as
 * unavailable. Chunk computations count as one permit while any of them runs, since under an
 * inherited grant they run inline on this thread. `before` holds a group's read before it asks for
 * its permits; meanwhile the read holds none.
 */
const spendingGraph = (
  before: (group: number) => Promise<void> = async () => {},
) => {
  let reads = 0;
  let chunks = 0;
  let peak = 0;
  const given: Array<number> = [];
  const byGroup: Array<{ group: number; permits: number }> = [];
  const stored = new Map<number, number>();
  const sample = () => {
    peak = Math.max(peak, reads + (chunks > 0 ? 1 : 0));
  };
  const spy = spyOn(GraphClient, "readGraphSymbols").mockImplementation(
    async (input) => {
      if (input.execute === undefined) throw new Error("no execute");
      const group = groupOf(input.files[0]?.path ?? "");
      await before(group);
      await input.execute(async (permits) => {
        given.push(permits);
        byGroup.push({ group, permits });
        reads += permits;
        sample();
        try {
          await Bun.sleep(300);
        } finally {
          reads -= permits;
        }
      }, input.signal ?? new AbortController().signal);
      throw new GraphClient.GraphSymbolsError({
        reason: "executable-unavailable",
        message: "Graph executable unavailable.",
      });
    },
  );
  const wrap = (store: Service): Service => ({
    ...store,
    run: (spec, compute) =>
      spec.op !== "harness.blob-chunks" && spec.op !== "harness.blob-structure"
        ? store.run(spec, compute)
        : counted(
            spec,
            store.run(
              spec,
              Effect.suspend(() => {
                chunks++;
                sample();
                return compute;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    chunks--;
                  }),
                ),
              ),
            ),
          ),
  });
  // A blob's structure is the last thing its group stores: once a group's sixteen have returned,
  // only in-memory work is left before the group ends.
  function counted<A, E, R>(
    spec: Computations.ComputationSpec,
    effect: Effect.Effect<A, E, R>,
  ) {
    if (spec.op !== "harness.blob-structure") return effect;
    const group = groupOf(
      String((spec.config as { path?: unknown }).path ?? ""),
    );
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => stored.set(group, (stored.get(group) ?? 0) + 1)),
      ),
    );
  }
  return {
    wrap,
    peak: () => peak,
    given: () => [...given],
    /** The permits each group's reads were given, by group. */
    byGroup: () =>
      [...byGroup]
        .sort((a, b) => a.group - b.group)
        .map(({ group, permits }) => [group, permits]),
    /**
     * Resolves once the groups have ended: their sixteen structures stored and nothing computing,
     * then the event loop drained so the in-memory rest of each group, its end included, has run.
     */
    ended: async (groups: ReadonlyArray<number>) => {
      while (
        chunks > 0 ||
        reads > 0 ||
        groups.some((group) => (stored.get(group) ?? 0) < 16)
      )
        await Bun.sleep(10);
      for (let turn = 0; turn < 5; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    },
    restore: () => spy.mockRestore(),
  };
};

// Why: a build with one size group (a small commit's preparation, the common case) gave its one
// group only part of the grant, so Graph ran on fewer workers than the job was given.
for (const permits of [1, 2, 3, 4, 5])
  test(`under an inherited grant of ${permits} a lone group's read is given the whole grant`, async () => {
    const restore = freshBudget(`lone-${permits}`);
    const graph = spendingGraph();
    try {
      const { entries, contents } = groupedInput(["md"]);
      const result = await within(
        run(
          blobChunks(root, entries, source, contents),
          `lone-${permits}`,
          graph.wrap,
          inheritedGrant(permits),
        ),
        `the build under a grant of ${permits}`,
        20_000,
      );
      expect(graph.given()).toEqual([permits]);
      expect(graph.peak()).toBe(permits);
      expect(result.computed).toBe(16);
    } finally {
      graph.restore();
      restore();
    }
  }, 30_000);

// Why: the last group, once every other group has finished, runs alone, so it must be given the
// whole grant; the groups overlapping each other still share it, so the grant is never passed.
for (const permits of [1, 2, 3, 4, 5])
  test(`under an inherited grant of ${permits} a last group reading alone is given the whole grant`, async () => {
    const restore = freshBudget(`last-${permits}`);
    // The third group's read waits until the first two groups have ended, so it starts alone.
    const graph: ReturnType<typeof spendingGraph> = spendingGraph(
      async (group) => {
        if (group !== 3) return;
        await graph.ended([1, 2]);
      },
    );
    try {
      const { entries, contents } = groupedInput(["md", "ts", "md"]);
      const result = await within(
        run(
          blobChunks(root, entries, source, contents),
          `last-${permits}`,
          graph.wrap,
          inheritedGrant(permits),
        ),
        `the build under a grant of ${permits}`,
        20_000,
      );
      const half = Math.max(1, Math.floor(permits / 2));
      expect(graph.byGroup()).toEqual([
        [1, half],
        [2, half],
        [3, permits],
      ]);
      expect(graph.peak()).toBe(permits);
      expect(result.computed).toBe(48);
    } finally {
      graph.restore();
      restore();
    }
  }, 30_000);

for (const [permits, given, peak] of [
  // One permit: the groups run one at a time, each read given the whole grant.
  [1, [1, 1, 1, 1], 1],
  // Two to five permits: two groups overlap, each read given half rounded down (an odd grant leaves
  // one permit idle), so two reads hold the grant at most. The last group starts while the third
  // still reads, so it shares too.
  [2, [1, 1, 1, 1], 2],
  [3, [1, 1, 1, 1], 2],
  [4, [2, 2, 2, 2], 4],
  [5, [2, 2, 2, 2], 4],
] as const)
  test(`under an inherited grant of ${permits} the groups together never hold more than it`, async () => {
    const restore = freshBudget(`inherited-${permits}`);
    const graph = spendingGraph();
    try {
      // Healthy and degraded groups both, as Markdown and TypeScript take different paths.
      const { entries, contents } = groupedInput(["md", "ts", "md", "ts"]);
      const result = await within(
        run(
          blobChunks(root, entries, source, contents),
          `inherited-${permits}`,
          graph.wrap,
          inheritedGrant(permits),
        ),
        `the build under a grant of ${permits}`,
        20_000,
      );
      expect(graph.peak()).toBe(peak);
      expect(graph.given()).toEqual([...given]);
      expect(result.computed).toBe(64);
    } finally {
      graph.restore();
      restore();
    }
  }, 30_000);

/**
 * A fake Graph whose reads wait in their preparation, before they ask for permits, until the test
 * releases their group, as Graph's executable copy and qualification do. A released read asks
 * through the real `execute` (the read's `cpuPool`), holds what it was given for a while, then
 * answers as unavailable. `holding` is the permits the reads hold at once.
 */
const preparingGraph = () => {
  type Files = Parameters<typeof readOutlines>[0];
  const called = new Map<number, PromiseWithResolvers<Files>>();
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const of = <A>(held: Map<number, PromiseWithResolvers<A>>, group: number) => {
    let value = held.get(group);
    if (value === undefined) held.set(group, (value = Promise.withResolvers()));
    return value;
  };
  const given: Array<[number, number]> = [];
  let holding = 0;
  let peak = 0;
  const spy = spyOn(GraphClient, "readGraphSymbols").mockImplementation(
    async (input) => {
      if (input.execute === undefined) throw new Error("no execute");
      const group = groupOf(input.files[0]?.path ?? "");
      of(called, group).resolve(input.files);
      await of(gates, group).promise;
      await input.execute(async (permits) => {
        given.push([group, permits]);
        holding += permits;
        peak = Math.max(peak, holding);
        try {
          await Bun.sleep(300);
        } finally {
          holding -= permits;
        }
      }, input.signal ?? new AbortController().signal);
      throw new GraphClient.GraphSymbolsError({
        reason: "executable-unavailable",
        message: "Graph executable unavailable.",
      });
    },
  );
  return {
    /** Resolves with the files of the group's read once it is preparing. */
    called: (group: number) => of(called, group).promise,
    release: (group: number) => of(gates, group).resolve(),
    /** The permits each read was given, by group. */
    given: () => [...given].sort((a, b) => a[0] - b[0]),
    peak: () => peak,
    restore: () => spy.mockRestore(),
  };
};

/**
 * A second caller of the same outline read (record 0016): it subscribes to the running read, so
 * that read keeps going when its group is stopped. `settled` resolves once the read has ended.
 */
const subscribe = async (files: Parameters<typeof readOutlines>[0]) => {
  const settled = readOutlines(files, source).then(
    () => "resolved",
    () => "rejected",
  );
  // Long enough for the subscriber to join the run before the group is stopped.
  await Bun.sleep(200);
  return { settled };
};

// Why: a group's share was fixed only when its read first asked for permits, after Graph's
// preparation, and counted the groups not finished. A read kept running by another subscriber after
// the build was interrupted then found no group unfinished and was given 1024 Graph workers, whatever
// the grant. An interrupted group keeps counting, so its late read takes its share and no more.
for (const groups of [["ts"], ["md", "ts"]] as const)
  for (const permits of [1, 2, 3, 4, 5])
    test(`under an inherited grant of ${permits} a read that asks for permits after its build of ${groups.length} group(s) was interrupted is given its share`, async () => {
      const name = `late-${groups.length}-${permits}`;
      const restore = freshBudget(name);
      const graph = preparingGraph();
      try {
        const { entries, contents } = groupedInput(groups);
        const build = Effect.runFork(
          provided(
            blobChunks(root, entries, source, contents),
            name,
            (store) => store,
            inheritedGrant(permits),
          ),
        );
        // Two groups prepare at once. A one-permit grant runs them one at a time, so there the first
        // group reads and ends as usual, and the second is the one interrupted while preparing.
        const late =
          groups.length === 2 && permits === 1
            ? [2]
            : groups.map((_, n) => n + 1);
        if (late[0] === 2) graph.release(1);
        const subscribers = await Promise.all(
          late.map(async (group) =>
            subscribe(
              await within(graph.called(group), `group ${group}'s read`),
            ),
          ),
        );
        await within(
          Effect.runPromise(Fiber.interrupt(build)),
          "the build's interruption",
        );
        for (const group of late) graph.release(group);
        await within(
          Promise.all(subscribers.map(({ settled }) => settled)),
          "the late reads",
          10_000,
        );
        const share =
          groups.length === 1
            ? permits
            : Math.floor(permits / Math.min(2, permits));
        expect(graph.given()).toEqual(groups.map((_, n) => [n + 1, share]));
        expect(graph.peak()).toBeLessThanOrEqual(permits);
      } finally {
        graph.restore();
        restore();
      }
    }, 30_000);

// Why: when a group's count dropped as it failed, the group beside it could, before it was
// interrupted, take the whole grant beside the failed group's share, and once both had ended its
// late read took 1024. A failed group keeps counting, so the other group's read, kept running by a
// subscriber, takes half and no more, whether it asks as the first group fails or after the build
// has returned. A one-permit grant runs the groups one at a time, so it has no such case.
for (const asks of ["as the first group fails", "after the build returned"])
  for (const permits of [2, 3, 4, 5])
    test(`under an inherited grant of ${permits} a group failing leaves the other group's read its half when it asks ${asks}`, async () => {
      const early = asks === "as the first group fails";
      const name = `failed-${early ? "early" : "late"}-${permits}`;
      const restore = freshBudget(name);
      const graph = preparingGraph();
      const fail = Promise.withResolvers<void>();
      // The first group's chunk computations wait for the test, then release the second group's read
      // and fail, so that read asks for permits as close to the failure as the test can bring it.
      const failing = (store: Service): Service => ({
        ...store,
        run: (spec, compute) =>
          spec.op === "harness.blob-chunks" &&
          groupOf(String((spec.config as { path?: unknown }).path ?? "")) === 1
            ? Effect.gen(function* () {
                yield* Effect.promise(() => fail.promise);
                if (early) graph.release(2);
                return yield* Effect.fail(
                  new Computations.SharedAttemptFailed({
                    key: "fixture",
                    attemptId: "fixture",
                    tag: "Fixture",
                    message: "group 1 failed",
                  }),
                );
              })
            : store.run(spec, compute),
      });
      try {
        const { entries, contents } = groupedInput(["md", "ts"]);
        graph.release(1);
        const pending = Effect.runPromise(
          Effect.exit(
            provided(
              blobChunks(root, entries, source, contents),
              name,
              failing,
              inheritedGrant(permits),
            ),
          ),
        );
        const subscriber = await subscribe(
          await within(graph.called(2), "the second group's read"),
        );
        fail.resolve();
        const exit = await within(pending, "the failed build");
        expect(Exit.isFailure(exit)).toBe(true);
        graph.release(2);
        await within(
          subscriber.settled,
          "the second group's late read",
          10_000,
        );
        const half = Math.floor(permits / 2);
        expect(graph.given()).toEqual([
          [1, half],
          [2, half],
        ]);
        expect(graph.peak()).toBeLessThanOrEqual(permits);
      } finally {
        fail.resolve();
        graph.restore();
        restore();
      }
    }, 30_000);
