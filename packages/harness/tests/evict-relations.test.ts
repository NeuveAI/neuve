// Why (design `records-evictable-outputs`, record 0016): the relations index is the first kind
// Records may evict. Its producer must declare it, an evicted index must read as never stored so
// the next review side computes it again under the same key, and a stored read that loses its
// index to an eviction between the row and the bytes must be a miss, not an error. Any other
// kind's missing bytes stay the error they were. Against a fake engine, as relations-round.test.ts.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Clock,
  Data,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
} from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import type { OutlineSource } from "../src/graph-outline.ts";
import { storedOutput } from "../src/search-index.ts";
import {
  NOT_STORED,
  RELATIONS_CAP_BYTES,
  RelationsIndex,
  relationsReadsInFlight,
  relationsRound,
  relationsSpec,
  storedRelations,
} from "../src/relations.ts";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
  await until(
    () => Effect.runSync(relationsReadsInFlight) === 0,
    "relations reads to end",
  );
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const OLD = "1".repeat(40);
const NEW = "3".repeat(40);
const OP = "harness.graph-relations";

const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** relations-round.test.ts's fake engine: a small compact stream per commit, each run recorded. */
const fakeEngine = (root: string): OutlineSource => {
  const control = join(root, "control");
  mkdirSync(control, { recursive: true });
  const executable = join(root, "engine");
  const script = `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const control = ${JSON.stringify(control)};
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
if (args[0] === "version") out({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") out({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["CALLS"],relation_support_by_language:{},relation_support_by_profile:{full:["CALLS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{compact_snapshot_ndjson_v1:true,exact_commit_bulk_streams:true},features_requiring_network_access:{}});
else {
  const commit = args[args.indexOf("--commit") + 1];
  appendFileSync(control + "/spawns", commit + "\\n");
  out(["h", 1, {schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:args[args.indexOf("--repo") + 1],repo_key:"local/r",commit,tree:"2".repeat(40),profile:"full",relation_set:["CALLS","IMPORTS"],skipped_relation_families:[]}]);
  out(["d", 1, ["file:a.ts","a.ts","blob","TypeScript","file:b.ts","b.ts","file:tests/a.test.ts","tests/a.test.ts"]]);
  out(["f", 1, 2, 3, 4, 10]); out(["f", 5, 6, 3, 4, 10]); out(["f", 7, 8, 3, 4, 10]);
  out(["d", 9, ["s:f","compound-v1","function","f","s:g","g"]]);
  out(["s", 9, 10, 11, 12, 12, 2, 1, 3, 0, 0, 4, 0, []]);
  out(["s", 13, 10, 11, 14, 14, 6, 1, 3, 0, 0, 4, 0, []]);
  out(["d", 15, ["CALLS","import_resolved","IMPORTS","call_site"]]);
  out(["r", 13, 9, 15, 0.9, 0, 0, 16, 0, [[18, 6, 2, 0, 0]], []]);
  out(["r", 7, 9, 15, 0.8, 0, 0, 16, 0, [[18, 8, 0, 0, 0]], []]);
  out(["r", 5, 1, 17, 0.9, 0, 0, 16, 0, [], []]);
  out(["m", {record_type:"summary",languages:["TypeScript"],language_tiers:{TypeScript:"semantic"},warnings:[],partial_failures:[],stats:{files:3,parsed_files:3,symbols:2,relations:3,partial_failures:0,completeness_level:"ok"},completeness:{languages:{},relations:{}}}]);
}
`;
  writeFileSync(executable, script, { mode: 0o700 });
  return {
    executable,
    key: { sha256: createHash("sha256").update(script).digest("hex") },
  };
};

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
};

/** What a test's blob store runs (once) before its next `getMany`, as an eviction racing it would. */
type Before = { next?: Effect.Effect<void> | undefined };

const racing = (location: StoreLocation, before: Before) =>
  Layer.effect(
    Blobs.BlobStore,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const hook = Effect.suspend(() => {
        const next = before.next;
        before.next = undefined;
        return next ?? Effect.void;
      });
      return Blobs.BlobStore.of({
        ...blobs,
        getMany: (hashes) => Effect.andThen(hook, blobs.getMany(hashes)),
      });
    }),
  ).pipe(Layer.provide(Blobs.layer(location)));

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "evict-relations-"));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "one");
  const location = storeLocationIn(join(root, "records"));
  const before: Before = {};
  const runtime = ManagedRuntime.make(
    Computations.layer.pipe(
      Layer.provideMerge(racing(location, before)),
      Layer.provideMerge(
        Layer.effectDiscard(Store.prepareForWrite).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Layer.provideMerge(BunFileSystem.layer),
    ),
  );
  runtimes.push(runtime);
  const control = join(root, "control");
  return {
    location,
    repository,
    graphDirectory: join(root, "graph"),
    source: fakeEngine(root),
    runtime,
    before,
    spawns: () =>
      existsSync(join(control, "spawns"))
        ? readFileSync(join(control, "spawns"), "utf8").trim().split("\n")
        : [],
  };
};

/** An eviction pass as run 16 minutes from now, so the outputs just stored are past its 15. */
const evictLater = (store: Computations.ComputationStore["Service"]) =>
  Effect.clockWith((real) =>
    Effect.provideService(store.evict({ op: OP }), Clock.Clock, {
      ...real,
      currentTimeMillisUnsafe: () =>
        real.currentTimeMillisUnsafe() + 16 * 60_000,
      currentTimeMillis: Effect.sync(
        () => real.currentTimeMillisUnsafe() + 16 * 60_000,
      ),
      currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
      currentTimeNanos: real.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: real.monotonicTimeNanos,
      sleep: (duration) => real.sleep(duration),
    }),
  );

const LONG_WAIT_MS = 60_000;

test("the relations index is declared; over the cap the oldest index goes, and the next side that needs it computes it again under the same key", async () => {
  const { runtime, repository, graphDirectory, source, spawns } = setup();
  const round = (base: string, head: string) =>
    runtime.runPromise(
      relationsRound({
        repository,
        graphDirectory,
        base,
        head,
        source,
        waitMs: LONG_WAIT_MS,
      }),
    );
  // OLD is stored first, then NEW beside it.
  const first = await round(OLD, OLD);
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  const second = await round(OLD, NEW);
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  const evicted = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const declared = yield* store.kinds;
      const keys = [OLD, NEW].map(
        (commit) =>
          Computations.computationKey(relationsSpec(commit, source)).key,
      );
      const held = yield* store.lookupMany(keys);
      const old = held.get(keys[0]!)!;
      const one = (yield* Blobs.BlobStore.use((blobs) =>
        blobs.inspect(held.get(keys[1]!)!.outputHash),
      ).pipe(Effect.map(Option.getOrThrow))).size;
      // A cap of one index: the oldest goes.
      yield* store.declareKind({ op: OP, capBytes: one });
      const report = yield* evictLater(store);
      const after = yield* store.lookupMany(keys);
      return {
        declared,
        old,
        report,
        oldStored: after.has(keys[0]!),
        newStored: after.has(keys[1]!),
      };
    }),
  );
  const third = await round(OLD, NEW);
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  const recomputed = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const key = Computations.computationKey(relationsSpec(OLD, source)).key;
      return Option.getOrThrow(yield* store.lookup(key));
    }),
  );
  expect(evicted.declared).toEqual([
    expect.objectContaining({ op: OP, capBytes: RELATIONS_CAP_BYTES }),
  ]);
  expect(first.outcomes).toEqual({ base: "computed", head: "computed" });
  expect(second.outcomes).toEqual({ base: "stored", head: "computed" });
  // The fake engine's index is small enough to be stored inline: its row held its bytes.
  expect(evicted.report).toMatchObject({
    outputs: 1,
    blobs: 1,
    storedBytes: 2 * evicted.report.capBytes!,
    remainingBytes: evicted.report.capBytes!,
  });
  expect(evicted.oldStored).toBe(false);
  expect(evicted.newStored).toBe(true);
  expect(third.outcomes).toEqual({ base: "computed", head: "stored" });
  expect(spawns()).toEqual([OLD, NEW, OLD]);
  expect(recomputed.key).toBe(evicted.old.key);
  expect(recomputed.attemptId).not.toBe(evicted.old.attemptId);
}, 120_000);

test("a stored read that loses the index to an eviction is a miss; another kind's missing bytes are still an error", async () => {
  const { runtime, repository, graphDirectory, source, before, location } =
    setup();
  await runtime.runPromise(
    relationsRound({
      repository,
      graphDirectory,
      base: OLD,
      head: OLD,
      source,
      waitMs: LONG_WAIT_MS,
    }),
  );
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const spec = relationsSpec(OLD, source);
      const durable = {
        op: "harness.test-durable",
        opVersion: 1,
        inputs: { commit: `git-commit:${OLD}` },
      };
      const kept = yield* store.run(
        durable,
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({ padding: "x".repeat(Blobs.INLINE_MAX_BYTES) }),
          ),
          mediaType: "application/json",
        }),
      );
      yield* store.declareKind({ op: OP, capBytes: 0 });
      // Between storedOutput's row read and its blob read, the eviction commits.
      before.next = Effect.asVoid(Effect.orDie(evictLater(store)));
      const raced = yield* storedOutput(spec, RelationsIndex);
      const stillStored = Option.isSome(
        yield* store.lookup(Computations.computationKey(spec).key),
      );
      before.next = Effect.sync(() =>
        rmSync(Blobs.blobPath(location, kept.computation.outputHash)),
      );
      const corrupt = yield* Effect.flip(storedOutput(durable, RelationsIndex));
      return { raced, stillStored, corrupt: corrupt._tag };
    }),
  );
  expect(Option.isNone(result.raced)).toBe(true);
  expect(result.stillStored).toBe(false);
  expect(result.corrupt).toBe("BlobCorrupt");
}, 120_000);

// Why: the stored-only lookup (`storedRelations`, which the readers use) reads an index's row and
// then its bytes; an eviction that commits between the two removes the bytes of a row it found. That
// is a miss, as if never stored, not a failed side; bytes missing while the row is unchanged are not
// an eviction and stay the store's error.
test("a stored-only lookup that loses the index to an eviction between its row and its bytes is not stored; other missing bytes stay an error", async () => {
  const { runtime, repository, graphDirectory, source, before } = setup();
  const round = (commit: string) =>
    runtime.runPromise(
      relationsRound({
        repository,
        graphDirectory,
        base: commit,
        head: commit,
        source,
        waitMs: LONG_WAIT_MS,
      }),
    );
  await round(OLD);
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  // Two other indexes take the process's two held places, so OLD's bytes are read again.
  for (const commit of ["4".repeat(40), "5".repeat(40)]) {
    await round(commit);
    await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  }
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const key = Computations.computationKey(relationsSpec(OLD, source)).key;
      const hash = Option.getOrThrow(yield* store.lookup(key)).outputHash;
      yield* store.declareKind({ op: OP, capBytes: 0 });
      // The row stays; only its bytes go missing: no eviction, so an error.
      before.next = Effect.fail(
        new Blobs.BlobMissing({ hash }),
      ) as unknown as Effect.Effect<void>;
      const missing = yield* storedRelations({ base: OLD, head: OLD, source });
      // Between the lookup's row read and its bytes, the eviction commits.
      before.next = Effect.asVoid(Effect.orDie(evictLater(store)));
      const raced = yield* storedRelations({ base: OLD, head: OLD, source });
      const stillStored = Option.isSome(yield* store.lookup(key));
      return { missing, raced, stillStored };
    }),
  );
  expect(result.missing.head).toEqual({ gap: "failed", tag: "BlobMissing" });
  expect(result.raced).toEqual({
    base: { gap: "over-bound", tag: NOT_STORED },
    head: { gap: "over-bound", tag: NOT_STORED },
  });
  expect(result.stillStored).toBe(false);
}, 120_000);

class DeclareRefused extends Data.TaggedError("DeclareRefused")<{}> {}

// Why: a failure to declare the cap must not stop the read, and must not be silent either.
test("a failed declaration of the cap is one warning, and the index is still computed", async () => {
  const { runtime, repository, graphDirectory, source } = setup();
  const lines: string[] = [];
  const round = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      return yield* relationsRound({
        repository,
        graphDirectory,
        base: OLD,
        head: OLD,
        source,
        waitMs: LONG_WAIT_MS,
      }).pipe(
        Effect.provideService(Computations.ComputationStore, {
          ...store,
          declareKind: () =>
            Effect.fail(new DeclareRefused()) as unknown as ReturnType<
              typeof store.declareKind
            >,
        }),
      );
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            for (const item of [message].flat())
              if (typeof item === "string") lines.push(item);
          }),
        ]),
      ),
    ),
  );
  await until(() => Effect.runSync(relationsReadsInFlight) === 0, "reads");
  expect(round.outcomes).toEqual({ base: "computed", head: "computed" });
  expect(lines.filter((line) => line.includes("was not declared"))).toEqual([
    `harness.graph-relations: the cap of ${RELATIONS_CAP_BYTES} bytes was not declared: DeclareRefused`,
  ]);
  const declared = await runtime.runPromise(
    Effect.flatMap(Computations.ComputationStore, (store) => store.kinds),
  );
  expect(declared).toEqual([]);
}, 120_000);
