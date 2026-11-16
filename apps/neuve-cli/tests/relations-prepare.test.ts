// Why (NEU-148): `neuve relations prepare <base>..<head>` stores both sides of a range before a
// review, so the review's readings, which decide from what is stored, find them. Checked here: with
// the real engine, that it stores what a review reads (the merge base, not the given base) and that
// a second run only reads it back; with a gated fake engine, that it joins a read another caller has
// in flight (record 0016: one engine start per key); and that its exit codes say what happened.
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Context,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  References,
  Tracer,
  type Fiber,
} from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { hostBudget } from "../../../packages/harness/src/budget/local.ts";
import {
  RELATIONS_FIXTURE_TIMEOUT_MS,
  relationsGraph,
  useRelationsFixture,
} from "../../../packages/harness/tests/fixtures/relations-real-fixture.ts";
import { fakeRelationsEngine } from "../../../packages/harness/tests/fixtures/relations-engine.ts";
import {
  isRelationsGap,
  prepareRangeRelations,
  relationsComputation,
  relationsGraphDirectory,
  relationsReadsInFlight,
  resolveRelationsRange,
  storedRelations,
} from "../../../packages/harness/src/relations.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * A budget host of this test's own, as the worker hosts the machine's (`hostBudget`): without one,
 * callers in two processes cannot meet (shared work's floor), so a join is not what is tested. Its
 * directory is short: a Unix socket's path is bounded.
 */
const hostedBudget = async () => {
  const directory = mkdtempSync(join(tmpdir(), "nb-"));
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("no budget host");
  await host.claims.ready;
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
};

/**
 * The CLI in a child process, with a scratch HOME so nothing reaches the user's registry, and this
 * test's budget host. Never `spawnSync`: the host is served by this process's event loop.
 */
const cli = async (
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) => {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

const fixture = useRelationsFixture();

// Why: the command must store what a review of the range reads, both sides, under the review's
// keys: the head and the MERGE BASE, not the given base; and a second run must read, not compute.
test.skipIf(relationsGraph.skip)(
  "stores the head and the merge base with the real engine, and a second run finds both stored",
  async () => {
    relationsGraph.require();
    await hostedBudget();
    expect(fixture.baseTip).not.toBe(fixture.base);
    const range = await fixture.run(
      resolveRelationsRange({
        repository: fixture.repository,
        base: fixture.baseTip,
        head: fixture.head,
      }),
    );
    expect(range).toEqual({
      base: fixture.baseTip,
      head: fixture.head,
      mergeBase: fixture.base,
    });
    const prepare = prepareRangeRelations({
      repository: fixture.repository,
      graphDirectory: fixture.graphDirectory,
      range,
      source: fixture.source,
    });
    const first = await fixture.run(prepare);
    expect(first.sides.head).toMatchObject({
      side: "head",
      commit: fixture.head,
      outcome: "read",
      tag: null,
    });
    expect(first.sides.base).toMatchObject({
      side: "base",
      commit: fixture.base,
      outcome: "read",
      tag: null,
    });
    expect(first.sides.head.bytes).toBeGreaterThan(0);
    expect(first.sides.base.bytes).toBeGreaterThan(0);
    // What a review's readings look up, for the range's merge base and head, is now stored.
    const stored = await fixture.run(
      storedRelations({
        base: fixture.base,
        head: fixture.head,
        source: fixture.source,
      }),
    );
    if (isRelationsGap(stored.head) || isRelationsGap(stored.base))
      throw new Error(`a side is not stored: ${JSON.stringify(stored)}`);
    expect(stored.head.coverage.commit).toBe(fixture.head);
    expect(stored.base.coverage.commit).toBe(fixture.base);
    const second = await fixture.run(prepare);
    expect(second.sides.head).toMatchObject({
      outcome: "already-stored",
      bytes: first.sides.head.bytes,
    });
    expect(second.sides.base).toMatchObject({
      outcome: "already-stored",
      bytes: first.sides.base.bytes,
    });
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);

// Why: the command as a user runs it, through the repository's own store: its JSON, its lines,
// exit 0, and the merge base as the base side when the given base differs from it.
test.skipIf(relationsGraph.skip)(
  "the command stores both sides into the repository's store and says so, then says already-stored",
  async () => {
    relationsGraph.require();
    await hostedBudget();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "relations-cli-")));
    roots.push(root);
    const range = `${fixture.baseTip}..${fixture.head}`;
    const first = await cli(root, [
      "relations",
      "prepare",
      range,
      "--json",
      "--repo",
      fixture.repository,
    ]);
    expect(first.code).toBe(0);
    const json = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      range: {
        base: fixture.baseTip,
        head: fixture.head,
        mergeBase: fixture.base,
      },
      head: { commit: fixture.head, outcome: "read", tag: null },
      base: { commit: fixture.base, outcome: "read", tag: null },
      stored: true,
    });
    const second = await cli(root, [
      "relations",
      "prepare",
      range,
      "--repo",
      fixture.repository,
    ]);
    expect(second.code).toBe(0);
    const lines = second.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(
        `^head  ${fixture.head}  already-stored  \\d+\\.\\d s  \\d+ bytes$`,
      ),
    );
    expect(lines[1]).toMatch(
      new RegExp(
        `^base  ${fixture.base}  already-stored  \\d+\\.\\d s  \\d+ bytes$`,
      ),
    );
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);

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
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/**
 * A repository whose range has a merge base other than its given base, a store and a fake engine
 * (which reads any commit the same way and records each commit it is started for).
 */
const setup = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relations-prepare-")));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(repository);
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "one");
  const mergeBase = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-q", "-b", "review");
  writeFileSync(join(repository, "b.ts"), "export const b = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "two");
  const head = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-q", "main");
  writeFileSync(join(repository, "c.ts"), "export const c = 3;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "three");
  const baseTip = git(repository, "rev-parse", "HEAD");
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
  const engine = fakeRelationsEngine(root);
  cleanups.push(async () => {
    // A test that fails mid-way must not leave a gated engine holding Graph's slot.
    engine.release();
    const deadline = Date.now() + 20_000;
    while (Effect.runSync(relationsReadsInFlight) > 0 && Date.now() < deadline)
      await Bun.sleep(10);
    await runtime.dispose();
  });
  return {
    root,
    repository,
    mergeBase,
    head,
    baseTip,
    graphDirectory: relationsGraphDirectory(location),
    runtime,
    engine,
  };
};

/** Whether a log line was written inside a relations read (`harness.graph.relations.read`). */
const inRelationsRead = (fiber: Fiber.Fiber<unknown, unknown>) => {
  let span = Context.getOption(fiber.context, Tracer.ParentSpan);
  while (Option.isSome(span) && span.value._tag === "Span") {
    if (span.value.name === "harness.graph.relations.read") return true;
    span = span.value.parent;
  }
  return false;
};

/**
 * `effect` with a logger that resolves `joined` when it subscribes, as a waiter, to a relations read
 * another caller holds: the read's own shared-work event (as `commit-relations.test.ts` observes it).
 */
const joining = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const joined = Promise.withResolvers<void>();
  return {
    joined: joined.promise,
    effect: effect.pipe(
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message, fiber }) => {
            if (
              inRelationsRead(fiber) &&
              [message]
                .flat()
                .some(
                  (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    "role" in item &&
                    item.role === "waiter",
                )
            )
              joined.resolve();
          }),
        ]),
      ),
    ),
  };
};

/** Waits until `condition` holds: an event the test observes; the deadline only ends a hang. */
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

// Why: record 0016 — a read another caller has in flight under the key is joined, never run twice.
test("a run started while another caller reads the head joins that read: one engine start for the head", async () => {
  await hostedBudget();
  const s = setup();
  s.engine.mode("gated");
  // Another caller (a review's relations task, say) reads the head; its engine holds.
  const other = s.runtime.runPromise(
    relationsComputation(
      s.repository,
      s.head,
      s.engine.source,
      s.graphDirectory,
    ),
  );
  await until(
    () => s.engine.spawns().includes(s.head),
    "the head engine to start",
  );
  const range = await s.runtime.runPromise(
    resolveRelationsRange({
      repository: s.repository,
      base: s.baseTip,
      head: s.head,
    }),
  );
  const prepare = joining(
    prepareRangeRelations({
      repository: s.repository,
      graphDirectory: s.graphDirectory,
      range,
      source: s.engine.source,
    }),
  );
  const prepared = s.runtime.runPromise(prepare.effect);
  await prepare.joined;
  s.engine.release();
  const [held, result] = await Promise.all([other, prepared]);
  expect(held.read.status).toBe("computed");
  expect(result.sides.head).toMatchObject({
    commit: s.head,
    outcome: "joined",
    tag: null,
    bytes: held.read.bytes,
  });
  expect(result.sides.base).toMatchObject({
    commit: s.mergeBase,
    outcome: "read",
  });
  // One engine start for the head, one for the merge base; the given base is never read.
  expect(s.engine.spawns()).toEqual([s.head, s.mergeBase]);
}, 120_000);

// Why: the exit codes are the command's contract for scripts (the gates lane's evaluations).
test("exit 0 when both sides are stored, 1 when a side failed, 2 for a usage error", async () => {
  await hostedBudget();
  const s = setup();
  const engine = { NEUVE_GRAPH_OUTLINE_EXECUTABLE: s.engine.source.executable };
  const range = `${s.baseTip}..${s.head}`;
  const run = (args: readonly string[], env = engine) =>
    cli(s.root, ["relations", "prepare", ...args], env);

  s.engine.mode("fail");
  const failed = await run([range, "--repo", s.repository]);
  expect(failed.code).toBe(1);
  const failedLines = failed.stdout.trim().split("\n");
  expect(failedLines).toHaveLength(2);
  expect(failedLines[0]).toMatch(
    new RegExp(`^head  ${s.head}  failed \\S+  \\d+\\.\\d s  -$`),
  );
  expect(failedLines[1]).toMatch(
    new RegExp(`^base  ${s.mergeBase}  failed \\S+  \\d+\\.\\d s  -$`),
  );

  s.engine.mode("valid");
  const stored = await run([range, "--json", "--repo", s.repository]);
  expect(stored.code).toBe(0);
  expect(JSON.parse(stored.stdout)).toMatchObject({
    head: { commit: s.head, outcome: "read" },
    base: { commit: s.mergeBase, outcome: "read" },
    stored: true,
  });

  const badRange = await run(["nope..HEAD", "--repo", s.repository]);
  expect(badRange.code).toBe(2);
  expect(badRange.stderr).toContain("nope is not a commit");
  const noRange = await run(["--repo", s.repository]);
  expect(noRange.code).toBe(2);
  const outside = join(s.root, "not-a-repository");
  mkdirSync(outside);
  const noRepository = await run([range, "--repo", outside]);
  expect(noRepository.code).toBe(2);
  expect(noRepository.stdout).toBe("");
  const noEngine = await run([range, "--repo", s.repository], {
    NEUVE_GRAPH_OUTLINE_EXECUTABLE: join(s.root, "no-engine"),
  });
  expect(noEngine.code).toBe(2);
  expect(noEngine.stderr).toContain("No Graph engine");
  const badTimeout = await run([
    range,
    "--timeout",
    "soon",
    "--repo",
    s.repository,
  ]);
  expect(badTimeout.code).toBe(2);
  // Only the failed and the valid runs started an engine: two sides each.
  expect(s.engine.spawns()).toHaveLength(4);
}, 120_000);
