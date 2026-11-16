import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { fakeRelationsEngine } from "./fixtures/relations-engine.ts";
import { slotsForTests, withGraphSlot } from "../src/graph-search.ts";
import { storedOutput } from "../src/search-index.ts";
import {
  NOT_STORED,
  RELATIONS_RECIPE,
  RelationsIndex,
  isRelationsGap,
  relationSlices,
  relationsComputation,
  relationsReadsInFlight,
  relationsRound,
  relationsSpec,
  storedRelations,
} from "../src/relations.ts";

/*
 * The stored computation and the round, against a fake engine that writes a small compact stream
 * and counts its snapshot runs. The real engine's tests are in relations-real.test.ts.
 */

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
/** What each test must undo however it ends: open gates, release gated engines, end held slots. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await settled();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const BASE = "1".repeat(40);
const HEAD = "3".repeat(40);

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      cwd,
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

const setup = (capable = true) => {
  const root = mkdtempSync(join(tmpdir(), "relations-round-"));
  roots.push(root);
  // A real repository, as the read clones it; the fake engine ignores the commits it is asked for.
  const repository = join(root, "repo");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "one");
  const graphDirectory = join(root, "graph");
  const location = storeLocationIn(join(root, "records"));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const engine = fakeRelationsEngine(root, capable);
  // A test that fails mid-way must not leave a gated engine holding Graph's slot.
  cleanups.push(async () => engine.release());
  return {
    root,
    repository,
    graphDirectory,
    source: engine.source,
    runtime,
    mode: (mode: string) =>
      engine.mode(mode as Parameters<typeof engine.mode>[0]),
    release: engine.release,
    spawns: engine.spawns,
    /** The `--repo` each snapshot run was given. */
    repos: engine.repos,
  };
};

/**
 * Waits until `condition` holds: an event the test observes (an engine started, a slot queued),
 * not a time margin. The deadline only turns a hang into a failure.
 */
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** Waits for detached reads to end (tests only: the worker uses the counter, never a poll). */
const settled = () =>
  until(
    () => Effect.runSync(relationsReadsInFlight) === 0,
    "relations reads to end",
  );

/** A wait no read here comes near, for rounds whose reads must be seen to finish. */
const LONG_WAIT_MS = 60_000;

// Why: record 0016 — one run per key; every other caller subscribes to it.
test("two concurrent rounds of the same commits make one engine run per commit", async () => {
  const { runtime, repository, graphDirectory, source, mode, release, spawns } =
    setup();
  mode("gated");
  const round = relationsRound({
    repository,
    graphDirectory,
    base: BASE,
    head: HEAD,
    source,
    waitMs: LONG_WAIT_MS,
  });
  const both = runtime.runPromise(
    Effect.all([round, round], { concurrency: 2 }),
  );
  // The head's engine runs and holds; only then may it finish.
  await until(() => spawns().includes(HEAD), "the head engine to start");
  release();
  const [one, two] = await both;
  await settled();
  expect(spawns().sort()).toEqual([BASE, HEAD]);
  for (const result of [one, two]) {
    expect(isRelationsGap(result.base)).toBe(false);
    expect(isRelationsGap(result.head)).toBe(false);
  }
  // One round ran the read. The other subscribed to it, or, if it looked only after the answer
  // was stored, read it stored; either way no second engine ran.
  const heads = [one.outcomes.head, two.outcomes.head].sort();
  expect(heads[0]).toBe("computed");
  expect<readonly string[]>(["shared", "stored"]).toContain(heads[1] ?? "");
  const head = one.head;
  if (isRelationsGap(head)) throw new Error("no head");
  expect(head.coverage.commit).toBe(HEAD);
  // g calls f through an import; the test file calls f.
  expect(head.edges.target).toHaveLength(2);
}, 120_000);

// Why: a stored answer must cost no engine process.
test("a stored answer is read without a spawn", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const round = relationsRound({
    repository,
    graphDirectory,
    base: BASE,
    head: HEAD,
    source,
    waitMs: LONG_WAIT_MS,
  });
  const first = await runtime.runPromise(round);
  await settled();
  expect(first.outcomes).toEqual({ base: "computed", head: "computed" });
  const second = await runtime.runPromise(round);
  expect(second.outcomes).toEqual({ base: "stored", head: "stored" });
  expect(spawns()).toHaveLength(2);
  expect(second.head).toEqual(first.head);
}, 120_000);

// Why: a cold read outlasts the review's wait; it must finish and store for the next request.
test("a wait that ends first is over-bound and the read still stores for the next round", async () => {
  const { runtime, repository, graphDirectory, source, mode, release, spawns } =
    setup();
  // The engine holds until released, so the short wait ends first whatever the machine's load.
  mode("gated");
  const first = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
      waitMs: 100,
    }),
  );
  expect(first.outcomes).toEqual({ base: "over-bound", head: "over-bound" });
  expect(first.head).toEqual({ gap: "over-bound", tag: null });
  expect(Effect.runSync(relationsReadsInFlight)).toBe(2);
  // Head started first and holds Graph's slot, so the base has not started.
  await until(() => spawns().length > 0, "the first engine to start");
  expect(spawns()).toEqual([HEAD]);
  release();
  await settled();
  expect(spawns()).toEqual([HEAD, BASE]);
  const second = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
    }),
  );
  expect(second.outcomes).toEqual({ base: "stored", head: "stored" });
  expect(spawns()).toEqual([HEAD, BASE]);
}, 120_000);

/** Holds Graph's slot, as a search does, until `release`; records its name and `note()` as it starts. */
const slotHolder = (
  started: string[],
  name: string,
  release: Deferred.Deferred<void>,
  urgent: () => boolean,
  note: () => string,
) =>
  withGraphSlot(urgent)(
    Effect.andThen(
      Effect.sync(() => started.push(`${name}@${note()}`)),
      Deferred.await(release),
    ),
  );

/** Callers queued for Graph's slot. Observed only; the slot is driven through `withGraphSlot`. */
const queued = () => slotsForTests.state().waiting;

// Why: record 0013 — one engine at a time in a process, so a relations read never runs beside a
// Graph search; a read a round still waits on goes before background Graph work, and once every
// wait has ended it falls behind waited-on work.
test("a relations read and a Graph slot holder do not run side by side, and the read is waited on only while a round waits", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const started: string[] = [];
  const reads = () => String(spawns().length);
  const gates = await Effect.runPromise(
    Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ]),
  );
  const [search, background, blocker, later] = gates;
  const holders: Fiber.Fiber<unknown, unknown>[] = [];
  const open = (gate: Deferred.Deferred<void>) =>
    Effect.runPromise(Deferred.succeed(gate, undefined));
  cleanups.push(async () => {
    for (const gate of gates) await open(gate);
    for (const holder of holders) await Effect.runPromise(Fiber.await(holder));
  });
  const hold = (name: string, gate: Deferred.Deferred<void>, urgent: boolean) =>
    holders.push(
      Effect.runFork(slotHolder(started, name, gate, () => urgent, reads)),
    );

  // A search holds the slot, and background Graph work queues behind it.
  hold("search", search, true);
  await until(() => started.length === 1, "the search to take the slot");
  hold("background", background, false);
  await until(() => queued() === 1, "the background work to queue");
  // The round's two reads queue after it, waited on: neither runs while the search holds the slot.
  const round = runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  await until(() => queued() === 3, "both reads to queue");
  expect(spawns()).toEqual([]);
  await open(search);
  const result = await round;
  expect(result.outcomes).toEqual({ base: "computed", head: "computed" });
  expect(spawns()).toEqual([HEAD, BASE]);
  // The background work, queued first, started only once both reads had left the slot.
  await until(() => started.length === 2, "the background work to start");
  expect(started).toEqual(["search@0", "background@2"]);

  // A round whose wait ends while a holder has the slot: its read is no longer waited on, so a
  // waited-on holder that queues after it runs first, and the read waits for it.
  hold("blocker", blocker, true);
  await until(() => queued() === 1, "the blocker to queue");
  await open(background);
  await until(() => started.length === 3, "the blocker to take the slot");
  const other = "5".repeat(40);
  const overBound = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: other,
      head: other,
      source,
      waitMs: 100,
    }),
  );
  expect(overBound.outcomes.head).toBe("over-bound");
  await until(() => queued() === 1, "the read to queue");
  hold("waited-on", later, true);
  await until(() => queued() === 2, "the waited-on holder to queue");
  await open(blocker);
  await until(() => started.length === 4, "the waited-on holder to start");
  expect(started).toEqual([
    "search@0",
    "background@2",
    "blocker@2",
    "waited-on@2",
  ]);
  expect(spawns()).toEqual([HEAD, BASE]);
  await open(later);
  await settled();
  expect(spawns()).toEqual([HEAD, BASE, other]);
}, 120_000);

// Why: an engine that cannot read an exact commit is a stated gap, not a failure or an empty answer.
test("an engine without the capability, or none at all, is graph-unavailable", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup(false);
  const round = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  expect(round.outcomes).toEqual({
    base: "graph-unavailable",
    head: "graph-unavailable",
  });
  expect(spawns()).toEqual([]);
  const missing = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source: {
        executable: join(repository, "absent"),
        key: { unavailable: "absent" },
      },
    }),
  );
  expect(missing.head).toEqual({ gap: "graph-unavailable", tag: null });
}, 120_000);

// Why: v5 stores what each site shows and the languages the engine declared for call lines; an index
// stored under v4 has neither, so its caller's first line must never be read as a call's line.
test("an index stored under the previous recipe is not found, and the round computes", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const current = relationsSpec(HEAD, source);
  // The same spec with the recipe this lane replaced: every other field is today's.
  const previous: Computations.ComputationSpec = JSON.parse(
    JSON.stringify(current).replace(
      `"recipe":"${RELATIONS_RECIPE}"`,
      '"recipe":"neuve-graph-relations-v4"',
    ),
  );
  expect(previous).not.toEqual(current);
  const old = { format: "neuve-graph-relations-v4" };
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        previous,
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(old)),
          mediaType: "application/json",
        }),
      );
    }),
  );
  expect(RELATIONS_RECIPE).toBe("neuve-graph-relations-v5");
  expect(Computations.computationKey(previous).key).not.toBe(
    Computations.computationKey(current).key,
  );
  expect(RelationsIndex.safeParse(old).success).toBe(false);
  const round = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: HEAD,
      head: HEAD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  expect(round.outcomes.head).toBe("computed");
  expect(spawns()).toEqual([HEAD]);
  if (isRelationsGap(round.head)) throw new Error("no head");
  expect(round.head.format).toBe("neuve-graph-relations-v5");
}, 120_000);

// Why: the engine refuses Git on a repository whose Git directory holds the worker's socket, so the
// read must name the store's private clone, never the repository, and make it once for the round.
test("every read is given the store's private clone, not the repository", async () => {
  const { runtime, repository, graphDirectory, source, repos } = setup();
  const round = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
  const clones = readdirSync(join(graphDirectory, "clones"));
  expect(clones).toHaveLength(1);
  const clone = join(realpathSync(graphDirectory), "clones", clones[0] ?? "");
  expect(repos()).toEqual([clone, clone]);
  expect(repos()).not.toContain(realpathSync(repository));
}, 120_000);

// Why: without a clone there is nothing the engine may read; the side is a named gap, not stored,
// and the next round with a clone it can make computes.
test("a clone that cannot be made is the gap failed with tag clone, and is not stored", async () => {
  const { runtime, root, repository, source, spawns } = setup();
  // A file where the Graph folder should be: the clone's folder cannot be made.
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "");
  const round = (graphDirectory: string) =>
    runtime.runPromise(
      relationsRound({
        repository,
        graphDirectory,
        base: BASE,
        head: HEAD,
        source,
        waitMs: LONG_WAIT_MS,
      }),
    );
  const failed = await round(join(blocked, "graph"));
  expect(failed.outcomes).toEqual({ base: "failed", head: "failed" });
  expect(failed.head).toEqual({ gap: "failed", tag: "clone" });
  expect(failed.base).toEqual({ gap: "failed", tag: "clone" });
  expect(spawns()).toEqual([]);
  const stored = await runtime.runPromise(
    storedOutput(relationsSpec(HEAD, source), RelationsIndex),
  );
  expect(Option.isNone(stored)).toBe(true);
  const again = await round(join(root, "graph"));
  expect(again.outcomes).toEqual({ base: "computed", head: "computed" });
}, 120_000);

// Why: a failed read must not take the stable key, or every later review would read the failure.
test("a failed run is not stored under the stable key", async () => {
  const { runtime, repository, graphDirectory, source, mode, spawns } = setup();
  mode("fail");
  const round = relationsRound({
    repository,
    graphDirectory,
    base: HEAD,
    head: HEAD,
    source,
    waitMs: LONG_WAIT_MS,
  });
  const failed = await runtime.runPromise(round);
  expect(failed.head).toEqual({ gap: "failed", tag: "command" });
  const stored = await runtime.runPromise(
    storedOutput(relationsSpec(HEAD, source), RelationsIndex),
  );
  expect(Option.isNone(stored)).toBe(true);
  mode("valid");
  const again = await runtime.runPromise(round);
  expect(again.outcomes.head).toBe("computed");
  expect(spawns()).toEqual([HEAD, HEAD]);
}, 120_000);

const NOT_STORED_GAP = { gap: "over-bound", tag: NOT_STORED } as const;

// Why: the readers decide in a review's first seconds and must never start a read: with nothing
// stored, the lookup gives each side the not-stored gap, distinct from a failed read, and no clone
// or engine is started.
test("the stored-only lookup with nothing stored gives two not-stored gaps and starts nothing", async () => {
  const { runtime, graphDirectory, source, spawns } = setup();
  const sides = await runtime.runPromise(
    storedRelations({ base: BASE, head: HEAD, source }),
  );
  expect(sides).toEqual({ base: NOT_STORED_GAP, head: NOT_STORED_GAP });
  expect(NOT_STORED).toBe("not-stored");
  expect(sides.head).not.toEqual(expect.objectContaining({ gap: "failed" }));
  expect(spawns()).toEqual([]);
  expect(existsSync(graphDirectory)).toBe(false);
  expect(Effect.runSync(relationsReadsInFlight)).toBe(0);
  // Without an engine both sides are graph-unavailable, as in a round.
  const missing = await runtime.runPromise(
    storedRelations({
      base: BASE,
      head: HEAD,
      source: {
        executable: join(graphDirectory, "absent"),
        key: { unavailable: "absent" },
      },
    }),
  );
  expect(missing).toEqual({
    base: { gap: "graph-unavailable", tag: null },
    head: { gap: "graph-unavailable", tag: null },
  });
}, 120_000);

// Why: each side is looked up on its own key; a stored head is had even while the base is not.
test("the stored-only lookup gives the one side that is stored and a gap for the other", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const computed = await runtime.runPromise(
    relationsComputation(repository, HEAD, source, graphDirectory),
  );
  expect(spawns()).toEqual([HEAD]);
  const sides = await runtime.runPromise(
    storedRelations({ base: BASE, head: HEAD, source }),
  );
  expect(sides.base).toEqual(NOT_STORED_GAP);
  expect(sides.head).toEqual(computed.read.index);
  expect(spawns()).toEqual([HEAD]);
}, 120_000);

// Why: what a round stored is what the lookup reads, by the same keys, and slices take it as is.
test("the stored-only lookup reads both sides a round stored, without a spawn", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const round = await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: BASE,
      head: HEAD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  await settled();
  expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
  const sides = await runtime.runPromise(
    storedRelations({ base: BASE, head: HEAD, source }),
  );
  expect(sides).toEqual({ base: round.base, head: round.head });
  expect(spawns()).toEqual([HEAD, BASE]);
  const [slice] = relationSlices(
    sides,
    [
      {
        key: "s",
        ranges: [{ side: "new", path: "a.ts", startLine: 2, lineCount: 1 }],
      },
    ],
    { base: () => false, head: (path) => path.startsWith("tests/") },
  );
  expect(slice?.head.read.kind).toBe("read");
  expect(slice?.head.symbols.map((entry) => entry.symbol.id)).toEqual(["s:f"]);
}, 120_000);

// Why: an index stored under an earlier recipe is a different answer; the lookup must not read it.
test("the stored-only lookup does not read an index stored under an older recipe", async () => {
  const { runtime, source, spawns } = setup();
  const current = relationsSpec(HEAD, source);
  const previous: Computations.ComputationSpec = JSON.parse(
    JSON.stringify(current).replace(
      `"recipe":"${RELATIONS_RECIPE}"`,
      '"recipe":"neuve-graph-relations-v4"',
    ),
  );
  expect(previous).not.toEqual(current);
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        previous,
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({ format: "neuve-graph-relations-v4" }),
          ),
          mediaType: "application/json",
        }),
      );
    }),
  );
  const sides = await runtime.runPromise(
    storedRelations({ base: HEAD, head: HEAD, source }),
  );
  expect(sides).toEqual({ base: NOT_STORED_GAP, head: NOT_STORED_GAP });
  expect(spawns()).toEqual([]);
}, 120_000);
