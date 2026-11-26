import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Context,
  Effect,
  Exit,
  type Fiber,
  Layer,
  Logger,
  Option,
  References,
  Tracer,
} from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { hostBudget } from "../src/budget/local.ts";
import {
  RELATIONS_START_BUDGET_MS,
  commitRelations,
  prepareCommitArgs,
} from "../src/commit-prepare.ts";
import type { OutlineSource } from "../src/graph-outline.ts";
import {
  NOT_STORED,
  isRelationsGap,
  relationsComputation,
  relationsGapOf,
  relationsReadsInFlight,
  relationsRound,
  storedRelations,
} from "../src/relations.ts";
import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
import { Settings, settingsPath } from "../src/settings.ts";
import { fakeRelationsEngine } from "./fixtures/relations-engine.ts";

const cli = resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts");

/*
 * Commit preparation's relations step (`commitRelations`) against the fake engine, which records
 * each snapshot run's commit. The real engine's end-to-end tests, through the preparation child,
 * are in commit-relations-real.test.ts.
 */

const roots: string[] = [];
/** What each test must undo however it ends: release gated engines, stop child processes. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const READINGS_ON = Option.some(
  Settings.parse({ version: 1, review: { sectionReadings: "probe" } }),
);
/** Legacy off settings remain parseable but no longer disable current preparation. */
const READINGS_OFF = Option.some(
  Settings.parse({ version: 1, review: { sectionReadings: "off" } }),
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
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/**
 * A repository whose first branch is `branch`, with one commit adding `file`; its store, where the
 * preparation child finds it (`<git directory>/neuve`); the fake engine.
 */
const setup = (branch = "main", file = "a.ts") => {
  const root = mkdtempSync(join(tmpdir(), "commit-relations-"));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(repository);
  git(repository, "init", "-q", "-b", branch);
  const commit = (file: string, text: string) => {
    writeFileSync(join(repository, file), text);
    git(repository, "add", ".");
    git(repository, "commit", "-qm", file);
    return git(repository, "rev-parse", "HEAD");
  };
  const first = commit(file, "export const a = 1;\n");
  const location = storeLocationIn(join(repository, ".git"));
  const engine = fakeRelationsEngine(root);
  cleanups.push(async () => engine.release());
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  /** Runs an effect over the store, with the log lines it writes at info and above. */
  const run = async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ) => {
    const lines: string[] = [];
    const value = await Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
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
    return { value, lines };
  };
  const step = (
    oid: string,
    over: Partial<Parameters<typeof commitRelations>[0]> = {},
  ) =>
    run(
      commitRelations({
        repository,
        storeDirectory: location.directory,
        commit: oid,
        source: engine.source,
        started: Date.now(),
        settings: READINGS_ON,
        ...over,
      }),
    );
  const stored = (base: string, head: string) =>
    run(storedRelations({ base, head, source: engine.source })).then(
      ({ value }) => value,
    );
  return {
    root,
    repository,
    location,
    engine,
    commit,
    first,
    run,
    step,
    stored,
    graphDirectory: join(location.directory, "graph"),
  };
};

const relationLines = (lines: readonly string[]) =>
  lines.filter((line) => line.startsWith("commit.prepare relations"));

const NOT_STORED_GAP = { gap: "over-bound", tag: NOT_STORED } as const;

// New comprehensive reviews require caller preparation even when an older settings file says off.
test("legacy readings-off settings still prepare and retain current committed relations", async () => {
  const s = setup();
  const { value, lines } = await s.step(s.first, { settings: READINGS_OFF });
  expect(value).toMatchObject({
    readings: true,
    commit: { commit: s.first, outcome: "read" },
  });
  expect(relationLines(lines)).toHaveLength(1);
  expect(s.engine.spawns()).toEqual([s.first]);
  expect(existsSync(s.graphDirectory)).toBe(true);
  const stored = await s.stored(s.first, s.first);
  expect(isRelationsGap(stored.base) || isRelationsGap(stored.head)).toBe(
    false,
  );
}, 120_000);

// Why: a review of a branch reads its head and its merge base with the default branch; both are
// read at commit time, the commit first, and a second preparation finds both stored.
test("a branch commit on top of a default-branch commit gets both read, the commit first", async () => {
  const s = setup();
  git(s.repository, "checkout", "-q", "-b", "feature");
  const head = s.commit("b.ts", "export const b = 2;\n");
  const { value, lines } = await s.step(head);
  expect(value).toMatchObject({
    readings: true,
    commit: { commit: head, outcome: "read", tag: null },
    mergeBase: { commit: s.first, outcome: "read", tag: null },
  });
  expect(s.engine.spawns()).toEqual([head, s.first]);
  expect(relationLines(lines)).toHaveLength(1);
  expect(relationLines(lines)[0]).toContain(`commit ${head.slice(0, 12)} read`);
  expect(relationLines(lines)[0]).toContain(
    `merge base ${s.first.slice(0, 12)} read`,
  );
  const sides = await s.stored(s.first, head);
  expect(isRelationsGap(sides.base) || isRelationsGap(sides.head)).toBe(false);
  // Prepared again (a retried job): both found stored, no engine.
  const again = await s.step(head);
  expect(again.value).toMatchObject({
    commit: { outcome: "already-stored" },
    mergeBase: { outcome: "already-stored" },
  });
  expect(s.engine.spawns()).toEqual([head, s.first]);
}, 120_000);

// Why: a commit on the default branch is its own merge base; its review's base is not known here.
test("a commit on the default branch itself gets one read", async () => {
  const s = setup();
  const head = s.commit("b.ts", "export const b = 2;\n");
  const { value, lines } = await s.step(head);
  expect(value).toMatchObject({
    commit: { commit: head, outcome: "read" },
    mergeBase: { skipped: "the commit is on refs/heads/main" },
  });
  expect(s.engine.spawns()).toEqual([head]);
  expect(relationLines(lines)[0]).toContain(
    "merge base skipped: the commit is on refs/heads/main",
  );
}, 120_000);

// Why: with no default branch known (no origin HEAD, no main or master), the base is not guessed.
test("with no default branch known the commit gets one read and a log line", async () => {
  const s = setup("trunk");
  git(s.repository, "checkout", "-q", "-b", "feature");
  const head = s.commit("b.ts", "export const b = 2;\n");
  const { value, lines } = await s.step(head);
  expect(value).toMatchObject({
    commit: { commit: head, outcome: "read" },
    mergeBase: { skipped: "no default branch known" },
  });
  expect(s.engine.spawns()).toEqual([head]);
  expect(relationLines(lines)[0]).toContain(
    "merge base skipped: no default branch known",
  );
}, 120_000);

// Why: with several merge bases a review's base is ambiguous; the step reads none of them.
test("with several merge bases only the commit is read", async () => {
  const s = setup();
  git(s.repository, "checkout", "-q", "-b", "feature");
  const side = s.commit("b.ts", "export const b = 2;\n");
  git(s.repository, "checkout", "-q", "main");
  const ahead = s.commit("c.ts", "export const c = 3;\n");
  // A criss-cross: main merges the feature commit, and the feature merges main's.
  git(s.repository, "merge", "-q", "--no-ff", "-m", "m1", side);
  git(s.repository, "checkout", "-q", "feature");
  git(s.repository, "merge", "-q", "--no-ff", "-m", "m2", ahead);
  const head = git(s.repository, "rev-parse", "HEAD");
  const { value } = await s.step(head);
  expect(value).toMatchObject({
    commit: { commit: head, outcome: "read" },
    mergeBase: { skipped: "2 merge bases with refs/heads/main" },
  });
  expect(s.engine.spawns()).toEqual([head]);
}, 120_000);

// Why: an amended commit is no longer where any review starts; its read would be wasted.
test("a commit that is no longer a branch tip nor HEAD is skipped with a log line", async () => {
  const s = setup();
  const amended = s.commit("b.ts", "export const b = 2;\n");
  git(s.repository, "commit", "-q", "--amend", "-m", "amended");
  const { value, lines } = await s.step(amended);
  expect(value).toMatchObject({
    readings: true,
    commit: { skipped: "no longer a branch tip nor HEAD" },
  });
  expect(s.engine.spawns()).toEqual([]);
  expect(existsSync(s.graphDirectory)).toBe(false);
  expect(relationLines(lines)[0]).toContain(
    "commit skipped: no longer a branch tip nor HEAD",
  );
  // A detached HEAD on it is where a review may start, so it is read.
  git(s.repository, "checkout", "-q", "--detach", amended);
  expect((await s.step(amended)).value).toMatchObject({
    commit: { outcome: "read" },
  });
}, 120_000);

// Why: a read starts only while it can still end inside the job's deadline.
test("past the start budget nothing is read", async () => {
  const s = setup();
  const { value } = await s.step(s.first, {
    started: Date.now() - RELATIONS_START_BUDGET_MS - 1,
  });
  expect(value).toMatchObject({
    commit: {
      skipped: `past ${RELATIONS_START_BUDGET_MS / 1000} s of the preparation`,
    },
  });
  expect(s.engine.spawns()).toEqual([]);
}, 120_000);

// Why: a failed read never fails the preparation; it is logged by its tag and nothing is stored,
// so the review's own task reads it.
test("a failed read is logged with its reason and stores nothing; the step never fails", async () => {
  const s = setup("trunk");
  s.engine.mode("fail");
  const { value, lines } = await s.step(s.first);
  expect(value).toMatchObject({
    commit: { commit: s.first, outcome: "failed", tag: "command" },
  });
  expect(relationLines(lines)[0]).toContain("failed (command)");
  expect(await s.stored(s.first, s.first)).toEqual({
    base: NOT_STORED_GAP,
    head: NOT_STORED_GAP,
  });
  // Without an engine: skipped with a log line, nothing started.
  const missing: OutlineSource = {
    executable: join(s.root, "absent"),
    key: { unavailable: "absent" },
  };
  const none = await s.step(s.first, { source: missing });
  expect(none.value).toMatchObject({ commit: { skipped: "no Graph engine" } });
  expect(relationLines(none.lines)[0]).toContain("skipped: no Graph engine");
  // An engine without the exact-commit capability: skipped, as the review's task does.
  const old = fakeRelationsEngine(join(s.root, "old"), false);
  const unable = await s.step(s.first, { source: old.source });
  expect(unable.value).toMatchObject({
    commit: { outcome: "graph-unavailable" },
  });
  expect(relationLines(unable.lines)[0]).toContain(
    "lacks the exact-commit capability",
  );
  expect(old.spawns()).toEqual([]);
}, 120_000);

/**
 * Waits until `condition` holds: an event the test observes (an engine started, a process ended),
 * not a time margin. The deadline only turns a hang into a failure.
 */
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

// Why: the worker's background slot runs one job at a time, so a newer commit recorded during this
// commit's own read waits behind this job; its merge base must not be read once it is stale.
test("a newer commit recorded during the commit's read stops the merge-base read", async () => {
  const s = setup();
  git(s.repository, "checkout", "-q", "-b", "feature");
  const head = s.commit("b.ts", "export const b = 2;\n");
  s.engine.mode("gated");
  const step = s.step(head);
  await until(() => s.engine.spawns().includes(head), "the commit's read");
  // A newer commit on the branch while the commit's own read runs.
  s.commit("c.ts", "export const c = 3;\n");
  s.engine.release();
  const { value, lines } = await step;
  expect(value).toMatchObject({
    commit: { commit: head, outcome: "read" },
    mergeBase: { skipped: "the commit is no longer a branch tip nor HEAD" },
  });
  expect(s.engine.spawns()).toEqual([head]);
  expect(relationLines(lines)[0]).toContain(
    "merge base skipped: the commit is no longer a branch tip nor HEAD",
  );
}, 120_000);

// Legacy switch values do not suppress the required preparation or its attributable telemetry.
test("required preparation emits its span for legacy-off, explicit-on and default settings", async () => {
  const s = setup("trunk");
  const spans = async (settings: Option.Option<Settings>) => {
    const records: RunLogRecord[] = [];
    const log = {
      path: "",
      write: (record: RunLogRecord) => {
        records.push(record);
      },
      read: () => records,
    };
    await s.run(
      commitRelations({
        repository: s.repository,
        storeDirectory: s.location.directory,
        commit: s.first,
        source: s.engine.source,
        started: Date.now(),
        settings,
      }).pipe(Effect.provideService(Tracer.Tracer, runLogTracer(log))),
    );
    return records
      .filter((record) => record.type === "span")
      .map((record) => record["name"]);
  };
  expect(await spans(READINGS_OFF)).toContain("harness.commit.relations");
  expect(await spans(READINGS_ON)).toContain("harness.commit.relations");
  // No setting at all is the default, and the default has readings on: the step runs.
  expect(await spans(Option.none())).toContain("harness.commit.relations");
}, 120_000);

/**
 * Whether a log line was written inside a relations read (`harness.graph.relations.read`): a
 * round's shared-work events for the store's clone are written outside it.
 */
const inRelationsRead = (fiber: Fiber.Fiber<unknown, unknown>) => {
  let span = Context.getOption(fiber.context, Tracer.ParentSpan);
  while (Option.isSome(span) && span.value._tag === "Span") {
    if (span.value.name === "harness.graph.relations.read") return true;
    span = span.value.parent;
  }
  return false;
};

/**
 * `effect` with a logger that resolves `joined` when it subscribes, as a waiter, to a relations
 * read another caller holds: the read's own shared-work event, never the clone's.
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

/**
 * A budget host for the test, and the worker's own preparation child (`neuve worker
 * prepare-commit`) for `s.first`, with readings on and the fake engine as its Graph engine, its
 * relations read started and holding the key. Stopped as the worker stops it (SIGTERM).
 */
const childHolding = async (s: ReturnType<typeof setup>) => {
  const directory = join(s.root, "budget");
  mkdirSync(directory, { mode: 0o700 });
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("no budget host");
  cleanups.push(() => host.close());
  await host.claims.ready;
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
  });
  const home = join(s.root, "home");
  mkdirSync(dirname(settingsPath(home)), { recursive: true });
  writeFileSync(
    settingsPath(home),
    JSON.stringify({ version: 1, review: { sectionReadings: "probe" } }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      ...prepareCommitArgs(s.repository, {
        oid: s.first,
        parents: [],
        tree: git(s.repository, "rev-parse", `${s.first}^{tree}`),
      }),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        NEUVE_BUDGET_DIRECTORY: directory,
        NEUVE_GRAPH_OUTLINE_EXECUTABLE: s.engine.source.executable,
      },
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then((parts) => parts.join(""));
  cleanups.push(async () => {
    s.engine.release();
    await child.exited;
    while (Effect.runSync(relationsReadsInFlight) > 0) await Bun.sleep(5);
  });
  // The child's engine runs and holds: the child holds the key.
  await until(() => {
    if (child.exitCode !== null) throw new Error("the child exited early");
    return s.engine.spawns().includes(s.first);
  }, "the child's engine to start");
  /** The child's relations log line. */
  const line = async () =>
    (await output)
      .split("\n")
      .find((text) => text.includes("commit.prepare relations")) ?? "";
  return { child, line };
};

// Why: record 0016 — one run per key across processes. The step runs in the preparation child; a
// review's round in the worker, another process, must join the read the child started, never run
// a second engine.
test("a round in one process joins the read the preparation step started in another", async () => {
  const s = setup("trunk", "README.md");
  s.engine.mode("gated");
  const { child, line } = await childHolding(s);
  const round = joining(
    relationsRound({
      repository: s.repository,
      graphDirectory: s.graphDirectory,
      base: s.first,
      head: s.first,
      source: s.engine.source,
      waitMs: 60_000,
    }),
  );
  const ended = s.run(round.effect);
  // Released only once the round subscribes to the child's read itself.
  await round.joined;
  s.engine.release();
  const { value } = await ended;
  expect(value.outcomes).toEqual({ base: "shared", head: "shared" });
  expect(isRelationsGap(value.head)).toBe(false);
  expect(await child.exited).toBe(0);
  expect(await line()).toContain(`commit ${s.first.slice(0, 12)} read in`);
  // One engine run, by the child, for both callers.
  expect(s.engine.spawns()).toEqual([s.first]);
}, 120_000);

// Why: a stopped holder publishes its own stop as the run's failure; a caller already joined to
// the read must not keep that gap: it asks once more and computes.
test("a round joined to the child's read computes it after the child is stopped", async () => {
  const s = setup("trunk", "README.md");
  s.engine.mode("gated");
  const { child } = await childHolding(s);
  const round = joining(
    relationsRound({
      repository: s.repository,
      graphDirectory: s.graphDirectory,
      base: s.first,
      head: s.first,
      source: s.engine.source,
      waitMs: 60_000,
    }),
  );
  const ended = s.run(round.effect);
  await round.joined;
  // The worker's stop.
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  s.engine.release();
  const { value } = await ended;
  expect(value.outcomes).toEqual({ base: "computed", head: "computed" });
  expect(s.engine.spawns()).toEqual([s.first, s.first]);
  const stored = await s.stored(s.first, s.first);
  expect(isRelationsGap(stored.head)).toBe(false);
}, 120_000);

// Why: a caller that arrives while the holder is being stopped, or after, takes the key over (or
// asks once more) and computes; it never keeps the stop as a gap.
test("a caller arriving as the child is stopped takes over and computes", async () => {
  const s = setup("trunk", "README.md");
  s.engine.mode("gated");
  const { child } = await childHolding(s);
  child.kill("SIGTERM");
  const read = s.run(
    Effect.exit(
      relationsComputation(
        s.repository,
        s.first,
        s.engine.source,
        s.graphDirectory,
      ),
    ),
  );
  expect(await child.exited).toBe(143);
  s.engine.release();
  const { value } = await read;
  if (Exit.isFailure(value)) throw new Error(String(value.cause));
  expect(value.value.read.status).toBe("computed");
  expect(s.engine.spawns()).toEqual([s.first, s.first]);
}, 120_000);

// Why: the one more ask is exactly one: when another holder's read fails for a real reason, the
// caller's own read fails too and its failure is returned, after two engine runs, never more.
test("another holder's real failure reaches a joined caller after exactly two engine runs", async () => {
  const s = setup("trunk", "README.md");
  s.engine.mode("gated-fail");
  const { child, line } = await childHolding(s);
  const read = joining(
    Effect.exit(
      relationsComputation(
        s.repository,
        s.first,
        s.engine.source,
        s.graphDirectory,
      ),
    ),
  );
  const ended = s.run(read.effect);
  await read.joined;
  s.engine.release();
  const { value } = await ended;
  if (Exit.isSuccess(value)) throw new Error("the read succeeded");
  expect(relationsGapOf(value.cause)).toEqual({
    gap: "failed",
    tag: "command",
  });
  expect(s.engine.spawns()).toEqual([s.first, s.first]);
  expect(await child.exited).toBe(0);
  expect(await line()).toContain(
    `commit ${s.first.slice(0, 12)} failed (command)`,
  );
}, 120_000);
