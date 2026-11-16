import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import type { GraphSnapshotCoverage } from "@neuve/graph-client";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import type { OutlineSource } from "../src/graph-outline.ts";
import { storedOutput } from "../src/search-index.ts";
import { fakeRelationsEngine } from "./fixtures/relations-engine.ts";
import {
  DECODED_RELATIONS_HELD,
  NOT_STORED,
  RELATIONS_RECIPE,
  RelationsIndex,
  RelationsIndexBuilder,
  isRelationsGap,
  relationCallerPaths,
  relationSliceViewsBuilt,
  relationSlices,
  relationsComputation,
  relationsIndexDecodes,
  relationsRound,
  relationsSpec,
  storedRelations,
  type RelationsSide,
} from "../src/relations.ts";
import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";

/*
 * The decoded indexes this process keeps by computation key (`relations-index.ts`). Decodes are
 * observed through the module's counter, never through time.
 */

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const store = () => {
  const root = mkdtempSync(join(tmpdir(), "relations-memo-"));
  roots.push(root);
  const location = storeLocationIn(join(root, "records"));
  const runtime = ManagedRuntime.make(
    Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(
        Layer.effectDiscard(Store.prepareForWrite).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Layer.provideMerge(BunFileSystem.layer),
    ),
  );
  runtimes.push(runtime);
  return { root, runtime };
};

const sourceOf = (engine: string): OutlineSource => ({
  executable: join(tmpdir(), "absent-engine"),
  key: { sha256: engine.repeat(64) },
});
const ENGINE = sourceOf("e");

const coverage = (repoKey: string): GraphSnapshotCoverage => ({
  provider: {
    name: "entire-graph",
    version: "fixture",
    identityRevision: "4",
    executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  },
  repoKey,
  schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  profile: "full",
  relationSet: ["CALLS", "CONSTRUCTS", "IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { TypeScript: "semantic" },
  counts: { files: 1, parsedFiles: 1, symbols: 1, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
});

/** A one-symbol index; `name` tells two indexes apart. */
const indexNamed = (name: string, repoKey = "local/r") => {
  const builder = new RelationsIndexBuilder();
  builder.file({
    id: "file:a.ts",
    path: "a.ts",
    language: "TypeScript",
    bytes: 1,
  });
  builder.symbol({
    id: name,
    name,
    qualifiedName: name,
    kind: "function",
    language: "TypeScript",
    path: "a.ts",
    startLine: 1,
    endLine: 2,
    containerId: null,
    signature: null,
  });
  return builder.finish(coverage(repoKey));
};

/** Stores `output` under the commit's key, as a finished computation. */
const put = (
  runtime: ReturnType<typeof store>["runtime"],
  commit: string,
  output: unknown,
  source: OutlineSource = ENGINE,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      yield* computations.run(
        relationsSpec(commit, source),
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(output)),
          mediaType: "application/json",
        }),
      );
    }),
  );

const decodes = () => Effect.runSync(relationsIndexDecodes);

/** The stored index of one commit (base and head the same: one lookup), or its gap. */
const lookup = async (
  runtime: ReturnType<typeof store>["runtime"],
  commit: string,
  source: OutlineSource = ENGINE,
): Promise<RelationsSide> =>
  (
    await runtime.runPromise(
      storedRelations({ base: commit, head: commit, source }),
    )
  ).head;

const symbolName = (side: RelationsSide) =>
  isRelationsGap(side) ? side : side.strings[side.symbols.name[0] ?? -1];

const commit = (digit: number) => String(digit).repeat(40);

// Why: the readers look a range's relations up once per reading group, dozens of times a range;
// each lookup decoded the whole index again (about half a second per side at this size).
test("a second lookup of a stored key decodes nothing and gives the same index", async () => {
  const { runtime } = store();
  const index = await indexNamed("first");
  await put(runtime, commit(1), index);
  const before = decodes();
  const first = await lookup(runtime, commit(1));
  expect(decodes()).toBe(before + 1);
  const second = await lookup(runtime, commit(1));
  expect(decodes()).toBe(before + 1);
  expect(second).toBe(first);
  // What the lookup gives is the stored index, decoded: the same value as before the memo.
  expect(first).toEqual(index);
  expect((first as RelationsIndex).format).toBe(RELATIONS_RECIPE);
});

// Why: the bound keeps memory bounded; the entry used longest ago must go first, never one in use.
test("past the bound the least recently used index is evicted first", async () => {
  expect(DECODED_RELATIONS_HELD).toBe(2);
  const { runtime } = store();
  const commits = [2, 3, 4].map(commit);
  for (const [at, each] of commits.entries())
    await put(runtime, each, await indexNamed(`n${at}`));
  const [two, three, four] = commits as [string, string, string];
  const decodedBy = async (each: string) => {
    const before = decodes();
    await lookup(runtime, each);
    return decodes() - before;
  };
  for (const each of [two, three]) expect(await decodedBy(each)).toBe(1);
  // Touch the older, so the next eviction takes the other.
  expect(await decodedBy(two)).toBe(0);
  expect(await decodedBy(four)).toBe(1);
  // Held: two, four. `three` went.
  for (const each of [two, four]) expect(await decodedBy(each)).toBe(0);
  expect(await decodedBy(three)).toBe(1);
  // Held: four, three. `two` went, the least recently used.
  expect(await decodedBy(two)).toBe(1);
  expect(symbolName(await lookup(runtime, two))).toBe("n0");
});

// Why: an index read by another engine is another answer; its key differs, so the memo must never
// serve one engine's index for the other's.
test("another engine's index is its own: the memo never serves it for the first engine's", async () => {
  const { runtime } = store();
  const other = sourceOf("f");
  await put(runtime, commit(7), await indexNamed("by-e"));
  await put(runtime, commit(7), await indexNamed("by-f"), other);
  expect(symbolName(await lookup(runtime, commit(7)))).toBe("by-e");
  const before = decodes();
  expect(symbolName(await lookup(runtime, commit(7), other))).toBe("by-f");
  expect(decodes()).toBe(before + 1);
  expect(symbolName(await lookup(runtime, commit(7)))).toBe("by-e");
  // An engine whose index is not stored finds nothing, however much is held.
  expect(await lookup(runtime, commit(7), sourceOf("a"))).toEqual({
    gap: "over-bound",
    tag: NOT_STORED,
  });
});

// Why: two stores may hold different bytes under one key (each clone names its own repository
// key); an entry is used only for the output it was decoded from.
test("two stores holding different outputs under one key each get their own", async () => {
  const one = store();
  const two = store();
  await put(one.runtime, commit(8), await indexNamed("x", "local/one"));
  await put(two.runtime, commit(8), await indexNamed("x", "local/two"));
  const first = await lookup(one.runtime, commit(8));
  const second = await lookup(two.runtime, commit(8));
  expect(isRelationsGap(first) ? null : first.coverage.repoKey).toBe(
    "local/one",
  );
  expect(isRelationsGap(second) ? null : second.coverage.repoKey).toBe(
    "local/two",
  );
});

// Why: a stored output that does not decode is a gap each time it is asked for, never a held
// value, and asking again decodes again.
test("a failed decode is not kept", async () => {
  const { runtime } = store();
  await put(runtime, commit(9), { format: RELATIONS_RECIPE });
  const before = decodes();
  const failed: RelationsSide = { gap: "failed", tag: "invalid-stored-output" };
  expect(await lookup(runtime, commit(9))).toEqual(failed);
  expect(await lookup(runtime, commit(9))).toEqual(failed);
  expect(decodes()).toBe(before + 2);
});

// Why: the round's stored read and the computation's stored read decode through the same memo, so
// a review's task, its round and the readers' lookups decode a side once between them.
test("the round's and the computation's stored reads share the decoded index", async () => {
  const { root, runtime } = store();
  await put(runtime, commit(1), await indexNamed("base"));
  await put(runtime, commit(3), await indexNamed("head"));
  const before = decodes();
  // Found stored: nothing is cloned or read; the repository is never touched.
  const computed = await runtime.runPromise(
    relationsComputation(
      join(root, "no-repository"),
      commit(3),
      ENGINE,
      join(root, "graph"),
    ),
  );
  expect(computed.read.status).toBe("reused");
  expect(decodes()).toBe(before + 1);
  const round = await runtime.runPromise(
    relationsRound({
      repository: join(root, "no-repository"),
      graphDirectory: join(root, "graph"),
      base: commit(1),
      head: commit(3),
      source: ENGINE,
      waitMs: 60_000,
    }),
  );
  expect(round.outcomes).toEqual({ base: "stored", head: "stored" });
  expect(round.head).toBe(computed.read.index);
  expect(decodes()).toBe(before + 2);
  const sides = await runtime.runPromise(
    storedRelations({ base: commit(1), head: commit(3), source: ENGINE }),
  );
  expect(sides.base).toBe(round.base);
  expect(sides.head).toBe(round.head);
  const again = await runtime.runPromise(
    relationsComputation(
      join(root, "no-repository"),
      commit(1),
      ENGINE,
      join(root, "graph"),
    ),
  );
  if (isRelationsGap(round.base)) throw new Error("the base was not stored");
  expect(again.read.index).toBe(round.base);
  expect(decodes()).toBe(before + 2);
});

/**
 * Runs `effect` with the store's blob reads counted per hash, and optionally held at a gate or
 * failed, so a test observes how many reads a set of lookups made.
 */
const countedBlobs = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: Readonly<{
    reads: Map<string, number>;
    gate?: Deferred.Deferred<void>;
    fail?: () => boolean;
    /** The store answers as if the blob's bytes were damaged, or as if the blob were gone. */
    blob?: () => "damaged" | "gone" | "kept";
  }>,
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const counted = {
      ...blobs,
      getMany: (hashes: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          for (const hash of hashes)
            options.reads.set(hash, (options.reads.get(hash) ?? 0) + 1);
          if (options.gate !== undefined) yield* Deferred.await(options.gate);
          if (options.fail?.() === true)
            return yield* new Blobs.BlobMissing({ hash: hashes[0] ?? "" });
          const blob = options.blob?.() ?? "kept";
          if (blob === "damaged")
            return yield* new Blobs.BlobCorrupt({
              hash: hashes[0] ?? "",
              message: "damaged",
            });
          if (blob === "gone") return new Map<string, Blobs.BlobRead>();
          return yield* blobs.getMany(hashes);
        }),
    };
    return yield* effect.pipe(Effect.provideService(Blobs.BlobStore, counted));
  });

const LOOKUPS = 65;
const hex = (letter: string) => letter.repeat(40);

// Why: a review's first seconds start one decision per reading group at once (65 on a 25-commit
// range), each looking up the same head and merge base; together they must read and decode each
// side once and share one index object, hence one slicing view.
test("65 lookups of one head and one base started together read and decode each side once and share one index and one view", async () => {
  const { runtime } = store();
  await put(runtime, hex("a"), await indexNamed("base"));
  await put(runtime, hex("b"), await indexNamed("head"));
  const reads = new Map<string, number>();
  const before = decodes();
  // The store's reads are held at a gate until every lookup has had its turn to start, so the
  // lookups are truly concurrent however fast the store answers.
  const results = await runtime.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* countedBlobs(
        Effect.gen(function* () {
          const all = yield* Effect.forkChild(
            Effect.all(
              Array.from({ length: LOOKUPS }, () =>
                storedRelations({
                  base: hex("a"),
                  head: hex("b"),
                  source: ENGINE,
                }),
              ),
              { concurrency: "unbounded" },
            ),
          );
          for (let turn = 0; turn < 4 * LOOKUPS; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          return yield* Fiber.join(all);
        }),
        { reads, gate },
      );
    }),
  );
  expect(decodes()).toBe(before + 2);
  expect([...reads.values()]).toEqual([1, 1]);
  const [first] = results;
  if (first === undefined) throw new Error("no lookup");
  expect(symbolName(first.base)).toBe("base");
  expect(symbolName(first.head)).toBe("head");
  for (const sides of results) {
    expect(sides.base).toBe(first.base);
    expect(sides.head).toBe(first.head);
  }
  const subjects = [
    {
      key: "s",
      ranges: [
        { side: "old" as const, path: "a.ts", startLine: 1, lineCount: 1 },
        { side: "new" as const, path: "a.ts", startLine: 1, lineCount: 1 },
      ],
    },
  ];
  const views = relationSliceViewsBuilt();
  const tests = { base: () => false, head: () => false };
  await Promise.all(
    results.map(async (sides) => {
      relationCallerPaths(sides, subjects);
      relationSlices(sides, subjects, tests);
    }),
  );
  expect(relationSliceViewsBuilt()).toBe(views + 2);
});

// Why: a reading group that stops must not take the index from the others waiting on the same read.
test("a lookup interrupted mid-read leaves the read to the others, who still get the index", async () => {
  const { runtime } = store();
  await put(runtime, hex("c"), await indexNamed("shared"));
  const reads = new Map<string, number>();
  const before = decodes();
  const results = await runtime.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* countedBlobs(
        Effect.gen(function* () {
          const fibers = [];
          for (let at = 0; at < LOOKUPS; at++)
            fibers.push(
              yield* Effect.forkChild(
                storedRelations({
                  base: hex("c"),
                  head: hex("c"),
                  source: ENGINE,
                }),
              ),
            );
          // The read has started and waits at the gate; the first caller stops.
          while (reads.size === 0) yield* Effect.yieldNow;
          const [stopped, ...rest] = fibers;
          if (stopped === undefined) throw new Error("no fiber");
          yield* Fiber.interrupt(stopped);
          yield* Deferred.succeed(gate, undefined);
          return yield* Effect.forEach(rest, Fiber.join);
        }),
        { reads, gate },
      );
    }),
  );
  expect(results).toHaveLength(LOOKUPS - 1);
  const [first] = results;
  if (first === undefined) throw new Error("no lookup");
  expect(symbolName(first.head)).toBe("shared");
  for (const sides of results) expect(sides.head).toBe(first.head);
  expect([...reads.values()]).toEqual([1]);
  expect(decodes()).toBe(before + 1);
});

// Why: a failed read is a gap for everyone who waited on it, and never held: the next lookup reads
// and decodes again.
test("a read that fails for every caller at once is not kept: the next lookup reads and decodes", async () => {
  const { runtime } = store();
  await put(runtime, hex("d"), await indexNamed("later"));
  const reads = new Map<string, number>();
  let failing = true;
  const before = decodes();
  const failed = await runtime.runPromise(
    countedBlobs(
      Effect.all(
        Array.from({ length: LOOKUPS }, () =>
          storedRelations({ base: hex("d"), head: hex("d"), source: ENGINE }),
        ),
        { concurrency: "unbounded" },
      ),
      { reads, fail: () => failing },
    ),
  );
  for (const sides of failed)
    expect(sides.head).toEqual({ gap: "failed", tag: "BlobMissing" });
  expect([...reads.values()]).toEqual([1]);
  expect(decodes()).toBe(before);
  failing = false;
  const later = await runtime.runPromise(
    countedBlobs(
      storedRelations({ base: hex("d"), head: hex("d"), source: ENGINE }),
      { reads, fail: () => failing },
    ),
  );
  expect(symbolName(later.head)).toBe("later");
  expect([...reads.values()]).toEqual([2]);
  expect(decodes()).toBe(before + 1);
});

// Why: two stores in one process that hold different bytes under one key must each keep their own
// decoded index, not evict each other on every lookup.
test("two stores with different bytes under one key, looked up in turn, decode twice in all", async () => {
  const one = store();
  const two = store();
  await put(one.runtime, hex("e"), await indexNamed("y", "local/one"));
  await put(two.runtime, hex("e"), await indexNamed("y", "local/two"));
  const before = decodes();
  for (let turn = 0; turn < 3; turn++) {
    const first = await lookup(one.runtime, hex("e"));
    const second = await lookup(two.runtime, hex("e"));
    expect(isRelationsGap(first) ? null : first.coverage.repoKey).toBe(
      "local/one",
    );
    expect(isRelationsGap(second) ? null : second.coverage.repoKey).toBe(
      "local/two",
    );
  }
  expect(decodes()).toBe(before + 2);
});

// Why: the one answer the memo changes. While an index is held its row is read but its blob is not,
// so a blob removed or damaged meanwhile still gives the held index (equal to what the blob held);
// once evicted, the side is the store's answer again, as before.
test("while held, a damaged or removed blob still gives the held index; once evicted, the store's answer", async () => {
  const { runtime } = store();
  const [kept, other, third] = [hex("f"), hex("9"), hex("8")];
  await put(runtime, kept, await indexNamed("kept"));
  await put(runtime, other, await indexNamed("other"));
  await put(runtime, third, await indexNamed("third"));
  const first = await lookup(runtime, kept);
  const reads = new Map<string, number>();
  let blob: "damaged" | "gone" | "kept" = "damaged";
  const lookupWith = (each: string) =>
    runtime.runPromise(
      countedBlobs(
        storedRelations({ base: each, head: each, source: ENGINE }),
        {
          reads,
          blob: () => blob,
        },
      ),
    );
  expect((await lookupWith(kept)).head).toBe(first);
  blob = "gone";
  expect((await lookupWith(kept)).head).toBe(first);
  expect(reads.size).toBe(0);
  // Two other indexes evict it.
  blob = "kept";
  await lookupWith(other);
  await lookupWith(third);
  blob = "damaged";
  expect((await lookupWith(kept)).head).toEqual({
    gap: "failed",
    tag: "BlobCorrupt",
  });
  blob = "gone";
  expect((await lookupWith(kept)).head).toEqual({
    gap: "over-bound",
    tag: NOT_STORED,
  });
  blob = "kept";
  expect(symbolName((await lookupWith(kept)).head)).toBe("kept");
});

// Why: the computing process looks its own index up next (the review's task computes, the readers
// look up); holding the computed index saves that decode, and is right only because it equals what
// decoding its stored bytes gives.
test("an index computed here is held, equal to its stored bytes decoded, and a lookup decodes nothing", async () => {
  const { root, runtime } = store();
  const repository = join(root, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        repository,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const engine = fakeRelationsEngine(root, true);
  const computed = await runtime.runPromise(
    relationsComputation(
      repository,
      hex("7"),
      engine.source,
      join(root, "graph"),
    ),
  );
  expect(computed.read.status).toBe("computed");
  const before = decodes();
  const sides = await runtime.runPromise(
    storedRelations({ base: hex("7"), head: hex("7"), source: engine.source }),
  );
  expect(decodes()).toBe(before);
  expect(sides.head).toBe(computed.read.index);
  const stored = await runtime.runPromise(
    storedOutput(relationsSpec(hex("7"), engine.source), RelationsIndex),
  );
  if (Option.isNone(stored)) throw new Error("not stored");
  expect(JSON.stringify(sides.head)).toBe(JSON.stringify(stored.value));
});

/** A one-commit repository under `root`, as a computation clones it; the fake engine ignores it. */
const repositoryIn = (root: string) => {
  const repository = join(root, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        repository,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "one");
  return repository;
};

/** Waits for an event the test observes; the deadline only turns a hang into a failure. */
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

// Why: at the floor of shared work two processes may compute one key at once, and when their
// outputs differ the store binds the first published and answers the other run with it, still as
// `computed`. What a caller gets must be what the store holds: the computation and every later
// lookup in the losing process give the stored output, never the object that process computed.
test("a computation whose output lost the race to another process gives the stored output, and so does a later lookup", async () => {
  const { root, runtime } = store();
  const repository = repositoryIn(root);
  const engine = fakeRelationsEngine(root, true);
  engine.mode("gated");
  const key = engine.source.key as { sha256: string };
  const running = runtime.runPromise(
    relationsComputation(
      repository,
      hex("6"),
      engine.source,
      join(root, "graph"),
    ),
  );
  try {
    await until(() => engine.spawns().length > 0, "the engine to start");
    // Another process, at the floor too (the test's budget folder has no host), publishes a
    // valid index of its own under the same key while this one's engine waits.
    const other = await indexNamed("other:f", "local/other-clone");
    const file = join(root, "other.json");
    writeFileSync(file, JSON.stringify(other));
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "relations-publish.ts"),
        join(root, "records"),
        hex("6"),
        engine.source.executable,
        key.sha256,
        file,
      ],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("computed");
  } finally {
    engine.release();
  }
  const computed = await running;
  // The store answered this run with the other process's output.
  expect(computed.read.status).toBe("computed");
  const stored = await runtime.runPromise(
    storedOutput(relationsSpec(hex("6"), engine.source), RelationsIndex),
  );
  if (Option.isNone(stored)) throw new Error("not stored");
  expect(stored.value.coverage.repoKey).toBe("local/other-clone");
  expect(JSON.stringify(computed.read.index)).toBe(
    JSON.stringify(stored.value),
  );
  const sides = await runtime.runPromise(
    storedRelations({ base: hex("6"), head: hex("6"), source: engine.source }),
  );
  expect(JSON.stringify(sides.head)).toBe(JSON.stringify(stored.value));
  expect(sides.head).toBe(computed.read.index);
});

// Why: a load in flight is shared only within one store; a caller of a healthy store must never
// get the answer of another store's read of the same key and output, gone there.
test("a load in flight is shared only within its store: another store's caller reads its own", async () => {
  const one = store();
  const two = store();
  const bytes = await indexNamed("both");
  await put(one.runtime, hex("5"), bytes);
  await put(two.runtime, hex("5"), bytes);
  const gate = Effect.runSync(Deferred.make<void>());
  const reads = new Map<string, number>();
  const first = one.runtime.runPromise(
    countedBlobs(
      storedRelations({ base: hex("5"), head: hex("5"), source: ENGINE }),
      { reads, gate, blob: () => "gone" },
    ),
  );
  await until(() => reads.size > 0, "the first store's read to start");
  // The first store's read waits at its gate; the second store's caller must not join it.
  const second = await two.runtime.runPromise(
    storedRelations({ base: hex("5"), head: hex("5"), source: ENGINE }).pipe(
      Effect.timeoutOption(30_000),
    ),
  );
  Effect.runSync(Deferred.succeed(gate, undefined));
  if (Option.isNone(second)) throw new Error("joined the other store's read");
  expect(symbolName(second.value.head)).toBe("both");
  expect((await first).head).toEqual({ gap: "over-bound", tag: NOT_STORED });
});

// Why: a load is shared only for one output: two callers of one store asking at once for one key
// with two different outputs (as two rows would give) each get their own index, never the other's.
test("a load in flight is shared only for its output hash", async () => {
  const { runtime } = store();
  await put(runtime, hex("4"), await indexNamed("first"));
  // A second output in the same store, under another key: its blob is the other output.
  await put(runtime, hex("3"), await indexNamed("second"));
  const reads = new Map<string, number>();
  const sides = await runtime.runPromise(
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      const keyOf = (commit: string) =>
        Computations.computationKey(relationsSpec(commit, ENGINE)).key;
      const secondRow = (yield* computations.lookupMany([keyOf(hex("3"))])).get(
        keyOf(hex("3")),
      );
      if (secondRow === undefined) throw new Error("not stored");
      // Asked for the first key, this store's rows answer with the second output's hash.
      const swapped = {
        ...computations,
        lookupMany: (keys: ReadonlyArray<string>) =>
          Effect.map(
            computations.lookupMany(keys),
            (rows) =>
              new Map(
                [...rows].map(([key, row]) => [
                  key,
                  { ...row, outputHash: secondRow.outputHash },
                ]),
              ),
          ),
      };
      const gate = yield* Deferred.make<void>();
      return yield* countedBlobs(
        Effect.gen(function* () {
          const plain = yield* Effect.forkChild(
            storedRelations({ base: hex("4"), head: hex("4"), source: ENGINE }),
          );
          while (reads.size === 0) yield* Effect.yieldNow;
          const other = yield* Effect.forkChild(
            storedRelations({
              base: hex("4"),
              head: hex("4"),
              source: ENGINE,
            }).pipe(
              Effect.provideService(Computations.ComputationStore, swapped),
            ),
          );
          while (reads.size < 2) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          return [yield* Fiber.join(plain), yield* Fiber.join(other)] as const;
        }),
        { reads, gate },
      );
    }),
  );
  expect(symbolName(sides[0].head)).toBe("first");
  expect(symbolName(sides[1].head)).toBe("second");
});

// Why: commit preparation reads relations inside a grant, where joining shared work in flight is
// refused; a load takes no claim and no grant, so it must be joined there, never refused.
test("inside a grant, a lookup and a computation's stored read join a load in flight", async () => {
  const { root, runtime } = store();
  await put(runtime, hex("2"), await indexNamed("granted"));
  const reads = new Map<string, number>();
  const results = await runtime.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      return yield* countedBlobs(
        Effect.gen(function* () {
          const outside = yield* Effect.forkChild(
            storedRelations({ base: hex("2"), head: hex("2"), source: ENGINE }),
          );
          while (reads.size === 0) yield* Effect.yieldNow;
          const lookup = yield* Effect.forkChild(
            storedRelations({
              base: hex("2"),
              head: hex("2"),
              source: ENGINE,
            }).pipe(Effect.provideService(InsideSharedWorkGrant, true)),
          );
          const computation = yield* Effect.forkChild(
            relationsComputation(
              join(root, "no-repository"),
              hex("2"),
              ENGINE,
              join(root, "graph"),
            ).pipe(Effect.provideService(InsideSharedWorkGrant, true)),
          );
          for (let turn = 0; turn < 4 * LOOKUPS; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          return {
            outside: (yield* Fiber.join(outside)).head,
            lookup: (yield* Fiber.join(lookup)).head,
            computation: (yield* Fiber.join(computation)).read.index,
          };
        }),
        { reads, gate },
      );
    }),
  );
  expect(symbolName(results.outside)).toBe("granted");
  expect(results.lookup).toBe(results.outside);
  if (isRelationsGap(results.outside)) throw new Error("not read");
  expect(results.computation).toBe(results.outside);
});
