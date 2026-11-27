// Why (NEU-148 WP11): the relations of a range's commits cost 25 to 60 s per commit cold, and their
// consumers wait for them only a short bound, so a review starts the read as a child task nobody
// waits for. These tests run the real task on a real pi Harness over a real Records store, against
// a fake engine that writes a small compact stream (as relations-round.test.ts does): what it stores,
// that it waits for the head tree's index first, that it never counts as waited on, how a cut-off,
// a stop and each failure end it, how it shares one run with a consumer's round (record 0016), and
// what a Graph search that meets its read in Graph's one slot gets (record 0013).
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
  type TaskOutcome,
  type Tx,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
} from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig, precomputeSettings } from "../src/config.ts";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import {
  captureOutlineSource,
  type OutlineSource,
} from "../src/graph-outline.ts";
import {
  graphClone,
  slotsForTests,
  withGraphSlot,
} from "../src/graph-search.ts";
import {
  Scheduler,
  type Budget,
  type Priority,
} from "../src/budget/scheduler.ts";
import { frontSettings, type RangeManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import {
  CONTINUED_READ_BOUND_MS,
  HEAD_GATE_BOUND_MS,
  RELATIONS_TASK,
  headGateOf,
  markReviewPublished,
  relationsGraphDirectory,
  relationsTask,
  type RelationsInput,
  type RelationsResult,
} from "../src/pi/stages/relations-task.ts";
import {
  reviewStages,
  stageRunner,
  type StageServices,
} from "../src/pi/stages/index.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import {
  RelationsIndex,
  isRelationsGap,
  relationsReadsInFlight,
  relationsRound,
  relationsSpec,
} from "../src/relations.ts";
import { indexOf } from "../src/retrievers.ts";
import { searchRuntimeFrom } from "../src/search-config.ts";
import { storedOutput } from "../src/search-index.ts";
import { Settings } from "../src/settings.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const ENGINE = "NEUVE_GRAPH_OUTLINE_EXECUTABLE";
const engineBefore = process.env[ENGINE];
afterAll(() => {
  if (engineBefore === undefined) delete process.env[ENGINE];
  else process.env[ENGINE] = engineBefore;
});

const roots: string[] = [];
/** What each test must undo however it ends: open gates, release gated engines, close harnesses. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await until(
    () => Effect.runSync(relationsReadsInFlight) === 0,
    "relations reads to end",
  );
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

/**
 * A fake engine: its snapshot (`--commit`) writes a small compact stream and records the commit, and
 * holds while `mode` is `gated` until `release` (or `release-<commit>`) exists. Anything else it is
 * asked (an outline read for the head tree's index) it refuses, so the index is built from the
 * chunker's fallback.
 */
const fakeEngine = (root: string, capable = true): OutlineSource => {
  const control = join(root, "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, "mode"), "valid");
  const executable = join(root, capable ? "engine" : "engine-old");
  const script = `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const control = ${JSON.stringify(control)};
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
if (args[0] === "version") out({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") out({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["CALLS"],relation_support_by_language:{},relation_support_by_profile:{full:["CALLS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{compact_snapshot_ndjson_v1:true,exact_commit_bulk_streams:${capable}},features_requiring_network_access:{}});
else if (!args.includes("--commit")) process.exit(2);
else {
  const mode = readFileSync(control + "/mode", "utf8");
  const commit = args[args.indexOf("--commit") + 1];
  appendFileSync(control + "/spawns", commit + "\\n");
  appendFileSync(control + "/repos", args[args.indexOf("--repo") + 1] + "\\n");
  out(["h", 1, {schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:args[args.indexOf("--repo") + 1],repo_key:"local/r",commit,tree:"2".repeat(40),profile:"full",relation_set:["CALLS","IMPORTS"],skipped_relation_families:[]}]);
  if (mode === "fail") process.exit(3);
  out(["d", 1, ["file:a.ts","a.ts","blob","TypeScript","file:b.ts","b.ts","file:tests/a.test.ts","tests/a.test.ts"]]);
  out(["f", 1, 2, 3, 4, 10]); out(["f", 5, 6, 3, 4, 10]); out(["f", 7, 8, 3, 4, 10]);
  out(["d", 9, ["s:f","compound-v1","function","f","s:g","g"]]);
  out(["s", 9, 10, 11, 12, 12, 2, 1, 3, 0, 0, 4, 0, []]);
  out(["s", 13, 10, 11, 14, 14, 6, 1, 3, 0, 0, 4, 0, []]);
  out(["d", 15, ["CALLS","import_resolved","IMPORTS","call_site"]]);
  out(["r", 13, 9, 15, 0.9, 0, 0, 16, 0, [[18, 6, 2, 0, 0]], []]);
  out(["r", 7, 9, 15, 0.8, 0, 0, 16, 0, [[18, 8, 0, 0, 0]], []]);
  out(["r", 5, 1, 17, 0.9, 0, 0, 16, 0, [], []]);
  if (mode === "gated") while (!existsSync(control + "/release") && !existsSync(control + "/release-" + commit)) await new Promise((resolve) => setTimeout(resolve, 10));
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
  return result.stdout.toString().trim();
};

/** Wraps the store's computation of one op: to hold it, fail it or see it start. */
type Wrap = <A, E, R>(
  compute: Effect.Effect<A, E, R>,
) => Effect.Effect<A, unknown, R>;

const LONG_WAIT_MS = 60_000;

/**
 * One review's store, repository, run context and pi Harness, with the relations task registered.
 * `chunks` wraps the head tree's index work on the file `held.txt`, which only the head tree holds
 * and no other test's tree, so the index is never answered from memory.
 */
const setup = async (
  options: {
    readonly capable?: boolean;
    readonly chunks?: Wrap;
    /** The real engine (`captureOutlineSource()`'s default) instead of the fake one. */
    readonly real?: boolean;
    /** The CPU budget the stages run in, as the worker gives its stage runner one. */
    readonly budget?: Budget;
    /**
     * The review stand-in also creates the head gate (`headGateOf`), its bound this long after the
     * review is created (the run's start is set back to make it so).
     */
    readonly gateBoundMs?: number;
    /** The bound of a read that goes on past the review's cut-off (`CONTINUED_READ_BOUND_MS`). */
    readonly continuedReadBoundMs?: number;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "relations-task-"));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "a.ts"), "export const a = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "base");
  const base = git(repository, "rev-parse", "HEAD");
  writeFileSync(join(repository, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repository, "held.txt"), `${basename(root)}\n`);
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "head");
  const head = git(repository, "rev-parse", "HEAD");
  const tree = (commit: string) =>
    git(repository, "rev-parse", `${commit}^{tree}`);

  const fake = fakeEngine(root, options.capable ?? true);
  if (options.real) {
    if (engineBefore === undefined) delete process.env[ENGINE];
    else process.env[ENGINE] = engineBefore;
  } else process.env[ENGINE] = fake.executable;
  const source = options.real ? captureOutlineSource() : fake;
  const control = join(root, "control");
  const release = (commit?: string) =>
    writeFileSync(
      join(control, commit === undefined ? "release" : `release-${commit}`),
      "",
    );
  cleanups.push(async () => release());
  const lines = (file: string) =>
    existsSync(join(control, file))
      ? readFileSync(join(control, file), "utf8").trim().split("\n")
      : [];

  const location = storeLocationIn(join(root, "records"));
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  const store = Context.get(built, Computations.ComputationStore);
  /** Every computation asked for, in order, by op (and `held.txt`'s chunks by name). */
  const ops: string[] = [];
  const computed: string[] = [];
  const records = Context.add(built, Computations.ComputationStore, {
    ...store,
    run: (spec, compute) => {
      const held =
        spec.op === "harness.blob-chunks" &&
        (spec.config as { path?: unknown } | undefined)?.path === "held.txt";
      ops.push(held ? "held-chunks" : spec.op);
      // Each relations read this store computes, by commit: the engine runs once per computation.
      const counted =
        spec.op === "harness.graph-relations"
          ? Effect.andThen(
              Effect.sync(() =>
                computed.push(
                  String(
                    (spec.inputs as Record<string, unknown>)["commit"],
                  ).slice("git-commit:".length),
                ),
              ),
              compute,
            )
          : compute;
      return store.run(
        spec,
        held && options.chunks !== undefined
          ? (options.chunks(counted) as typeof compute)
          : counted,
      );
    },
  });
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));

  const runId = mintUlid();
  const config = defaultConfig();
  const manifest: RangeManifest = {
    range: {
      baseOid: base,
      headOid: head,
      mergeBase: base,
      baseTree: tree(base),
      headTree: tree(head),
    },
    settings: frontSettings(precomputeSettings(config)),
    files: 1,
    reviewLines: 1,
    hunks: [],
    facts: [],
    declarations: { readers: [], gaps: [] },
    limitations: [],
  };
  const manifestSpec: Computations.ComputationSpec = {
    op: "test.range-manifest",
    opVersion: 1,
    inputs: { root: basename(root) },
  };
  await Effect.runPromise(
    Effect.provide(
      store.run(
        manifestSpec,
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(manifest)),
          mediaType: "application/json",
        }),
      ),
      built,
    ),
  );
  const manifestKey = Computations.computationKey(manifestSpec).key;

  const logged: RunLogRecord[] = [];
  const log: RunLog = {
    path: "(memory)",
    write: (record) => {
      logged.push(record);
    },
    read: () => logged,
  };
  const ctx = {
    location,
    repository,
    runId,
    runKey: "f".repeat(64),
    range: { baseRef: "main", baseOid: base, headOid: head },
    cycleId: mintUlid(),
    config,
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const integrations = { status: "absent" as const, path: "(none)" };
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), scope),
    ),
    McpClients,
  );
  const registry = createRegistry();
  const noAgents = () => Promise.reject(new Error("no agents in this test"));
  const services: StageServices = {
    ctx,
    runtimes: testRuntimes().registry,
    routes: { bindAgentRoute: noAgents, prepareFinalGeneration: noAgents },
    capture: () => {},
    registry,
    integrations,
    clients,
    run: stageRunner(ctx, clients, options.budget),
    endRound: async () => {},
  };
  const task = relationsTask(services, options.continuedReadBoundMs);
  /**
   * The review as this task meets it: it creates the task as owned work, then, once the test lets it
   * publish, commits its completed outcome with the publish mark, as `review-task.ts`'s Publish does,
   * and holds as `completing` until the task ends.
   */
  let publishNow = () => {};
  const publishGate = new Promise<void>((resolve) => {
    publishNow = resolve;
  });
  cleanups.push(async () => publishNow());
  type ReviewState =
    | { readonly phase: "start" }
    | {
        readonly phase: "publish";
        readonly child: number;
        readonly gate?: number;
      };
  const review = defineTask<
    RelationsInput,
    ReviewState,
    { readonly child: number }
  >({
    name: "test.review",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (reviewTask, runtime, context) => {
        await runtime.commit(async (tx) => {
          const child = await tx.createTask(task, reviewTask.input, {
            ownership: { kind: "task", taskId: runtime.taskId },
          });
          const bound = options.gateBoundMs;
          const gate =
            bound === undefined
              ? undefined
              : await headGateOf(task, {
                  startedAt: Date.now() - HEAD_GATE_BOUND_MS + bound,
                })(tx, reviewTask.input, runtime.taskId);
          return {
            status: "running",
            checkpoint: {
              phase: "publish",
              child: Number(child),
              ...(gate === undefined ? {} : { gate: Number(gate) }),
            },
          };
        }, context);
      },
      publish: async (reviewTask, runtime, context) => {
        await Promise.race([
          publishGate,
          new Promise((_, reject) =>
            runtime.signal.addEventListener("abort", () =>
              reject(runtime.signal.reason),
            ),
          ),
        ]);
        const at = reviewTask.state.checkpoint;
        await runtime.commit(async (tx) => {
          await markReviewPublished(tx, runtime.taskId);
          return {
            status: "terminal",
            outcome: { status: "completed", result: { child: at.child } },
          };
        }, context);
      },
    },
    abort: (_, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  /**
   * A reading as it waits on the head gate: it commits `waiting` on the gate (not its child) with
   * `allSettled`, and once woken ends with the gate's outcome as it read it.
   */
  type Woke = {
    readonly outcome: string;
    readonly status?: RelationsResult["status"];
  };
  const waiter = defineTask<
    { readonly gate: number },
    { readonly phase: "wait" } | { readonly phase: "woke" },
    Woke
  >({
    name: "test.waiter",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (waiterTask, runtime, context) =>
        runtime.commit(
          () => ({
            status: "waiting",
            on: [waiterTask.input.gate as TaskId],
            policy: "allSettled",
            checkpoint: { phase: "woke" },
          }),
          context,
        ),
      woke: async (waiterTask, runtime, context) => {
        const [outcome] = await runtime.outcomes(
          [waiterTask.input.gate as TaskId<RelationsResult>],
          context,
        );
        const result = (outcome as { result?: RelationsResult } | undefined)
          ?.result;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                outcome: String(outcome?.status),
                ...(result === undefined ? {} : { status: result.status }),
              },
            },
          }),
          context,
        );
      },
    },
    abort: (_, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  registry.install(
    defineExtension({
      name: "test.relations",
      tasks: [task, review, waiter],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  cleanups.push(() => harness.close(context));
  const conversation = await harness.root(context);
  harness.resume();
  /** Creates the task for the stored manifest (or `manifest`), with its cut-off this far away. */
  const start = async (cutoffAfterMs = 600_000, manifest = manifestKey) =>
    (await harness.commit(
      (tx) =>
        tx.createTask(
          task,
          { manifest, cutoffAt: Date.now() + cutoffAfterMs },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        ),
      context,
    )) as TaskId<RelationsResult>;
  /** Creates a head gate no review owns, with its cut-off (its bound) this far away. */
  const startGate = async (cutoffAfterMs = 600_000) =>
    (await harness.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            manifest: manifestKey,
            cutoffAt: Date.now() + cutoffAfterMs,
            headGate: true,
          },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        ),
      context,
    )) as TaskId<RelationsResult>;
  /** Creates a waiter on `gate`; its outcome is what it read of the gate once woken. */
  const waitOn = async (gate: TaskId<RelationsResult>) =>
    (await harness.commit(
      (tx) =>
        tx.createTask(
          waiter,
          { gate: Number(gate) },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        ),
      context,
    )) as TaskId<Woke>;
  /** The waiter's status now, and its outcome once it ended. */
  const waiterStatus = async (id: TaskId<Woke>) =>
    (await harness.getTask(id, context))?.state.status;
  const woke = async (id: TaskId<Woke>) =>
    (await harness.waitForTask(id, context)).state.outcome as TaskOutcome<Woke>;
  /** Creates the review stand-in, which creates the task with its cut-off this far away. */
  const startReview = async (cutoffAfterMs = 600_000) =>
    (await harness.commit(
      (tx) =>
        tx.createTask(
          review,
          { manifest: manifestKey, cutoffAt: Date.now() + cutoffAfterMs },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        ),
      context,
    )) as TaskId<{ readonly child: number }>;
  /** The task the review stand-in created, once the commit that creates it is in. */
  const childOf = async (id: TaskId<{ readonly child: number }>) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const state = (await harness.getTask(id, context))?.state as
        { readonly checkpoint?: ReviewState } | undefined;
      if (state?.checkpoint?.phase === "publish")
        return state.checkpoint.child as TaskId<RelationsResult>;
      if (Date.now() > deadline)
        throw new Error("timed out waiting for the review to create the task");
      await Bun.sleep(5);
    }
  };
  /** The head gate the review stand-in created (`gateBoundMs`), once the commit that creates it is in. */
  const gateOf = async (id: TaskId<{ readonly child: number }>) => {
    await childOf(id);
    const state = (await harness.getTask(id, context))?.state as
      { readonly checkpoint?: ReviewState } | undefined;
    const checkpoint = state?.checkpoint;
    if (checkpoint?.phase !== "publish" || checkpoint.gate === undefined)
      throw new Error("the review created no head gate");
    return checkpoint.gate as TaskId<RelationsResult>;
  };
  /** The review stand-in's own status, as pi committed it. */
  const reviewStatus = async (id: TaskId<{ readonly child: number }>) =>
    (await harness.getTask(id, context))?.state.status;
  const ended = async (id: TaskId<RelationsResult>) =>
    (await harness.waitForTask(id, context)).state
      .outcome as TaskOutcome<RelationsResult>;
  const keyOf = (commit: string) =>
    Computations.computationKey(relationsSpec(commit, source)).key;
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Computations.ComputationStore | Blobs.BlobStore
    >,
  ) => Effect.runPromise(Effect.provide(effect, records));
  const round = (commits: { base: string; head: string }) =>
    run(
      relationsRound({
        repository,
        graphDirectory: relationsGraphDirectory(location),
        ...commits,
        source,
        waitMs: LONG_WAIT_MS,
      }),
    );
  const stored = (commit: string) =>
    run(storedOutput(relationsSpec(commit, source), RelationsIndex));
  /** Builds the head tree's index, as the leads task's prefetch does. */
  const headIndex = () =>
    services.run(indexOf(repository, manifest.range.headTree, source));
  return {
    root,
    repository,
    base,
    head,
    source,
    location,
    services,
    harness,
    manifestKey,
    log: logged,
    ops,
    computed,
    start,
    startGate,
    waitOn,
    waiterStatus,
    woke,
    startReview,
    childOf,
    gateOf,
    reviewStatus,
    publish: () => publishNow(),
    ended,
    keyOf,
    round,
    stored,
    headIndex,
    mode: (mode: string) => writeFileSync(join(control, "mode"), mode),
    release,
    spawns: () => lines("spawns"),
    repos: () => lines("repos"),
  };
};
type Setup = Awaited<ReturnType<typeof setup>>;

const rows = (s: Setup) => s.log.filter((r) => r.type === "range.relations");
const spanAttributes = (s: Setup, name: string) =>
  s.log
    .filter((r) => r.type === "span" && r["name"] === name)
    .map((r) => r["attributes"] as Record<string, unknown>);
/** Callers queued for Graph's slot. Observed only; the slot is driven through `withGraphSlot`. */
const queued = () => slotsForTests.state().waiting;
const inUse = () => slotsForTests.state().inUse;

/** Holds Graph's slot, as a search does, until `gate` opens; records `name@note()` as it starts. */
const holder = (
  started: string[],
  name: string,
  gate: Deferred.Deferred<void>,
  urgent: () => boolean,
  note: () => string = () => "",
) =>
  Effect.runFork(
    withGraphSlot(urgent)(
      Effect.andThen(
        Effect.sync(() => started.push(`${name}@${note()}`)),
        Deferred.await(gate),
      ),
    ),
  );
/** Gates the test opens however it ends, and the holders it waits for. */
const gates = async (count: number) => {
  const made = await Effect.runPromise(
    Effect.all(Array.from({ length: count }, () => Deferred.make<void>())),
  );
  const holders: Fiber.Fiber<unknown, unknown>[] = [];
  const open = (gate: Deferred.Deferred<void>) =>
    Effect.runPromise(Deferred.succeed(gate, undefined));
  cleanups.push(async () => {
    for (const gate of made) await open(gate);
    for (const fiber of holders) await Effect.runPromise(Fiber.await(fiber));
  });
  return { made, holders, open };
};

// Why: the task's whole purpose: both sides stored once, head first, the base being the merge base
// the diff's old side is; its result and rows carry keys and outcomes only; a consumer's round
// afterwards finds both stored and starts no engine.
test("the task stores the head's then the base's relations, and a round afterwards reads both stored", async () => {
  const s = await setup();
  const outcome = await s.ended(await s.start());
  const side = (commit: string) => ({
    commit,
    key: s.keyOf(commit),
    outcome: "computed" as const,
    wallMs: expect.any(Number),
    records: 8,
  });
  expect(outcome).toEqual({
    status: "completed",
    result: { status: "stored", head: side(s.head), base: side(s.base) },
  });
  expect(s.spawns()).toEqual([s.head, s.base]);
  // The head tree's index came first: every chunk of it was asked for before the first read.
  expect(s.ops.indexOf("held-chunks")).toBeGreaterThan(-1);
  expect(s.ops.lastIndexOf("harness.blob-chunks")).toBeLessThan(
    s.ops.indexOf("harness.graph-relations"),
  );
  expect(rows(s)).toEqual([
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "head",
      ...side(s.head),
    },
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "base",
      ...side(s.base),
    },
  ]);
  // Keys and outcomes, never source text.
  expect(JSON.stringify(rows(s))).not.toContain("export const");
  // The phase's span ends after its terminal commit.
  await until(
    () => spanAttributes(s, "harness.pi.phase").length > 0,
    "the phase's span",
  );
  expect(spanAttributes(s, "harness.pi.commit")).toContainEqual(
    expect.objectContaining({
      "harness.task_kind": "relations",
      "harness.phase": "run",
      "harness.next_phase": "terminal",
    }),
  );
  expect(spanAttributes(s, "harness.pi.phase")).toContainEqual(
    expect.objectContaining({ "harness.task_kind": "relations" }),
  );
  // No index row or span of its own: the leads task owns the prefetch's.
  expect(s.log.filter((r) => r.type === "index.prefetch")).toEqual([]);
  expect(spanAttributes(s, "harness.index.prefetch")).toEqual([]);
  // The reads used the store's one Graph clone, the folder Graph search uses.
  const clones = readdirSync(
    join(relationsGraphDirectory(s.location), "clones"),
  );
  expect(clones).toHaveLength(1);
  const clone = join(
    realpathSync(relationsGraphDirectory(s.location)),
    "clones",
    clones[0] ?? "",
  );
  expect(s.repos()).toEqual([clone, clone]);
  const after = await s.round({ base: s.base, head: s.head });
  expect(after.outcomes).toEqual({ base: "stored", head: "stored" });
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why: the reads and Graph search must share one private clone per repository and store, so the
// task's folder must be the one the worker gives Graph search (`handler.ts` passes the store's
// folder, `location.directory`, to `searchRuntimeFrom`).
test("the task's Graph folder is the search runtime's work directory for the store", async () => {
  const s = await setup();
  const runtime = searchRuntimeFrom(
    Option.some(
      Settings.parse({
        version: 1,
        search: { graph: { executable: s.source.executable } },
      }),
    ),
    s.location.directory,
  );
  expect(runtime.graph?.workDirectory).toBe(
    relationsGraphDirectory(s.location),
  );
});

/** Holds the head index's chunk of `held.txt` until `release`, then computes it or fails it. */
const heldChunks = (end: "computes" | "fails") => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = { entered: 0, ended: 0 };
  const wrap: Wrap = <A, E, R>(compute: Effect.Effect<A, E, R>) => {
    const body: Effect.Effect<A, unknown, R> =
      end === "computes"
        ? compute
        : Effect.fail(new Error("chunk fixture failure"));
    return Effect.andThen(
      Effect.sync(() => {
        seen.entered++;
      }),
      Effect.andThen(
        Effect.promise(() => held),
        Effect.ensuring(
          body,
          Effect.sync(() => {
            seen.ended++;
          }),
        ),
      ),
    );
  };
  cleanups.push(async () => release());
  return { wrap, seen, release };
};

// Why (the timeline lane's shape change): the finders wait for the head tree's index, so a cold
// read's engine must not start while that build runs; and the build's end, ready or failed, must
// let the reads start, head first, or a failed index would cost the review its relations.
for (const end of ["computes", "fails"] as const)
  test(`with the head index held no read starts; when it ${end === "computes" ? "is ready" : "fails"}, the reads start, head first`, async () => {
    const chunks = heldChunks(end);
    const s = await setup({ chunks: chunks.wrap });
    const id = await s.start();
    await until(() => chunks.seen.entered === 1, "the head index to be held");
    // Nothing ran before the index's chunk was asked for, and nothing has run since.
    expect(s.ops).not.toContain("harness.graph-relations");
    expect(s.spawns()).toEqual([]);
    s.ops.push("released");
    chunks.release();
    const outcome = await s.ended(id);
    expect(chunks.seen.ended).toBe(1);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "stored",
        head: { outcome: "computed" },
        base: { outcome: "computed" },
      },
    });
    expect(s.ops.indexOf("harness.graph-relations")).toBeGreaterThan(
      s.ops.indexOf("released"),
    );
    expect(s.spawns()).toEqual([s.head, s.base]);
  }, 120_000);

// Why: the review stays `completing` until this task ends, so the task must end at the cut-off by
// itself, here while it still waits for the head index, which never ends in this test.
test("at the cut-off the task ends as cutoff, each side not read named, and starts no engine", async () => {
  const chunks = heldChunks("computes");
  const s = await setup({ chunks: chunks.wrap });
  const outcome = await s.ended(await s.start(1_000));
  const side = (commit: string) => ({
    commit,
    key: s.keyOf(commit),
    outcome: "cutoff" as const,
    wallMs: 0,
  });
  expect(outcome).toEqual({
    status: "completed",
    result: {
      status: "cutoff",
      head: side(s.head),
      base: side(s.base),
      detail: "the review's cut-off came first",
    },
  });
  expect(rows(s)).toEqual([
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "head",
      ...side(s.head),
    },
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "base",
      ...side(s.base),
    },
  ]);
  expect(s.ops).not.toContain("harness.graph-relations");
  expect(s.spawns()).toEqual([]);
}, 120_000);

// Why: a stopped review must not leave a read running that nobody wants: the task was the only
// subscriber, so its shared run has none left and is stopped. Its engine is gated and would hold
// Graph's slot until released; the slot frees without that, and nothing is stored.
test("a stop during a read the task alone subscribed to withdraws it", async () => {
  const s = await setup();
  s.mode("gated");
  const id = await s.start();
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  expect(inUse()).toBe(1);
  await s.harness.abortTask(id, context);
  expect(await s.ended(id)).toEqual({
    status: "aborted",
    reason: "stopped",
    result: { status: "stopped" },
  });
  expect(rows(s)).toEqual([
    { type: "range.relations", manifest: s.manifestKey, outcome: "stopped" },
  ]);
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (record 0016): a consumer's round during the task's read joins it, never a second run; and a
// stop of the task then leaves the read running for the round, which gets its answer.
test("a round joins the task's read, and the task's stop leaves the read running for the round", async () => {
  const s = await setup();
  s.mode("gated");
  const id = await s.start();
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  const joined = s.round({ base: s.head, head: s.head });
  // The round's own ask of the store: it subscribes to the running read in that call.
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 2,
    "the round to ask for the head's relations",
  );
  await setImmediate();
  await s.harness.abortTask(id, context);
  expect((await s.ended(id)).status).toBe("aborted");
  // Still running for the round: its engine holds the slot.
  expect(inUse()).toBe(1);
  s.release();
  const round = await joined;
  expect(round.outcomes.head).toBe("shared");
  expect(isRelationsGap(round.head)).toBe(false);
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (the readers lane's finding): once the review's packet is published no consumer of the review
// reads either side, so the review must not hold as `completing` for a read nobody in it needs.
// Published while the base's read runs, the task stops that read and the review is terminal at once,
// without the gated engine being released; the task was the read's only subscriber, so the read is
// withdrawn and nothing is stored for the base, while the head it already stored stays stored.
test("a review published while the base's read runs is terminal at once, and the read is withdrawn", async () => {
  const s = await setup();
  s.mode("gated");
  s.release(s.head);
  const review = await s.startReview();
  const id = await s.childOf(review);
  await until(() => s.spawns().includes(s.base), "the base engine to start");
  expect(inUse()).toBe(1);
  s.publish();
  expect((await s.harness.waitForTask(review, context)).state.outcome).toEqual({
    status: "completed",
    result: { child: id },
  });
  const base = {
    commit: s.base,
    key: s.keyOf(s.base),
    outcome: "published" as const,
    wallMs: expect.any(Number),
  };
  const head = {
    commit: s.head,
    key: s.keyOf(s.head),
    outcome: "computed" as const,
    wallMs: expect.any(Number),
    records: 8,
  };
  expect(await s.ended(id)).toEqual({
    status: "completed",
    result: {
      status: "published",
      head,
      base,
      detail: "the review's packet was published first",
    },
  });
  expect(rows(s)).toEqual([
    { type: "range.relations", manifest: s.manifestKey, side: "head", ...head },
    { type: "range.relations", manifest: s.manifestKey, side: "base", ...base },
  ]);
  // The base's wall time so far: its engine had started.
  expect(
    rows(s).find((row) => row["side"] === "base")?.["wallMs"],
  ).toBeGreaterThan(0);
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  s.release();
  expect(Option.isNone(await s.stored(s.base))).toBe(true);
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why (record 0016): a read another caller subscribed to is that caller's too, so the published
// packet stops only this task's subscription: the review is terminal at once, and the base's read
// runs on for the round that joined it, which gets its answer, stored for the next caller.
test("a review published while a round shares the base's read is terminal at once, and the read runs on for the round", async () => {
  const s = await setup();
  s.mode("gated");
  s.release(s.head);
  const review = await s.startReview();
  const id = await s.childOf(review);
  await until(() => s.spawns().includes(s.base), "the base engine to start");
  const joined = s.round({ base: s.base, head: s.head });
  // The task's head and base, then the round's base: the head it finds stored.
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 3,
    "the round to ask for the base's relations",
  );
  await setImmediate();
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect(await s.ended(id)).toMatchObject({
    status: "completed",
    result: {
      status: "published",
      head: { outcome: "computed" },
      base: { outcome: "published" },
    },
  });
  // Still running for the round: its engine holds the slot.
  expect(inUse()).toBe(1);
  s.release();
  const round = await joined;
  expect(round.outcomes).toEqual({ head: "stored", base: "shared" });
  expect(Option.isSome(await s.stored(s.base))).toBe(true);
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why: the mark changes nothing for a task that already ended: both sides stay stored and the task's
// outcome is the one it committed before the packet was published.
test("a review published after both sides ended changes nothing", async () => {
  const s = await setup();
  const review = await s.startReview();
  const id = await s.childOf(review);
  const side = (commit: string) => ({
    commit,
    key: s.keyOf(commit),
    outcome: "computed" as const,
    wallMs: expect.any(Number),
    records: 8,
  });
  expect(await s.ended(id)).toEqual({
    status: "completed",
    result: { status: "stored", head: side(s.head), base: side(s.base) },
  });
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect(rows(s).map((row) => row["outcome"])).toEqual([
    "computed",
    "computed",
  ]);
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why: the watch of the mark must leave the cut-off as it was for a task a review owns: before the
// packet, the cut-off ends the task as `cutoff`, each side named with no wall time.
test("a task a review owns still ends at the cut-off as before", async () => {
  const chunks = heldChunks("computes");
  const s = await setup({ chunks: chunks.wrap });
  const review = await s.startReview(1_000);
  const id = await s.childOf(review);
  const side = (commit: string) => ({
    commit,
    key: s.keyOf(commit),
    outcome: "cutoff" as const,
    wallMs: 0,
  });
  expect(await s.ended(id)).toEqual({
    status: "completed",
    result: {
      status: "cutoff",
      head: side(s.head),
      base: side(s.base),
      detail: "the review's cut-off came first",
    },
  });
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect(s.spawns()).toEqual([]);
}, 120_000);

// Why: and the stop: a stopped review aborts the task before itself, which commits `stopped` and
// withdraws the read it alone subscribed to, as for a task no review owns.
test("a stopped review still stops the task it owns, which withdraws its read", async () => {
  const s = await setup();
  s.mode("gated");
  const review = await s.startReview();
  const id = await s.childOf(review);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  await s.harness.abortTask(review, context);
  expect(await s.ended(id)).toEqual({
    status: "aborted",
    reason: "stopped",
    result: { status: "stopped" },
  });
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("aborted");
  expect(rows(s)).toEqual([
    { type: "range.relations", manifest: s.manifestKey, outcome: "stopped" },
  ]);
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (record 0016, the other way): a read a consumer's round started is joined by the task, which
// starts no engine of its own for that commit.
test("the task joins a round's read of the head", async () => {
  const s = await setup();
  // The head index first, as the leads task builds it: a gated engine holds its CPU grant, and the
  // tests' budget has one, so the task's own wait for the index would otherwise wait on the read.
  await s.headIndex();
  s.mode("gated");
  const first = s.round({ base: s.head, head: s.head });
  await until(() => s.spawns().includes(s.head), "the round's engine to start");
  const id = await s.start();
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 2,
    "the task to ask for the head's relations",
  );
  await setImmediate();
  s.release();
  expect((await first).outcomes.head).toBe("computed");
  expect(await s.ended(id)).toMatchObject({
    status: "completed",
    result: {
      status: "stored",
      head: { outcome: "shared" },
      base: { outcome: "computed" },
    },
  });
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why (point 3 of the brief): nobody waits for the task, so its read must be background work in
// Graph's slot: background work queued before it goes first. A round that joins it waits on it,
// and from then it goes before that background work.
for (const joined of [false, true])
  test(`the task's read is ${joined ? "waited on once a round joins it" : "not waited on by itself"}`, async () => {
    const s = await setup();
    // Joined, the head's engine holds until released, so the order is seen while it runs.
    if (joined) s.mode("gated");
    const started: string[] = [];
    const { made, holders, open } = await gates(2);
    const [search, background] = made as [
      Deferred.Deferred<void>,
      Deferred.Deferred<void>,
    ];
    const reads = () => String(s.spawns().length);
    holders.push(holder(started, "search", search, () => true, reads));
    await until(() => started.length === 1, "the search to take the slot");
    holders.push(holder(started, "background", background, () => false, reads));
    await until(() => queued() === 1, "the background work to queue");
    const id = await s.start();
    await until(() => queued() === 2, "the head's read to queue");
    let round: Promise<unknown> | undefined;
    if (joined) {
      round = s.round({ base: s.head, head: s.head });
      await until(
        () =>
          s.ops.filter((op) => op === "harness.graph-relations").length === 2,
        "the round to ask for the head's relations",
      );
      await setImmediate();
      // It joined: no second read queued.
      expect(queued()).toBe(2);
    }
    await open(search);
    if (joined) {
      // The read, waited on, went first: the background work had not started when it ran.
      await until(() => s.spawns().includes(s.head), "the head's read");
      expect(started).toEqual(["search@0"]);
      s.release();
      await round;
      await until(() => started.length === 2, "the background work");
      expect(started).toEqual(["search@0", "background@1"]);
    } else {
      await until(() => started.length === 2, "the background work");
      expect(started).toEqual(["search@0", "background@0"]);
      expect(s.spawns()).toEqual([]);
    }
    await open(background);
    expect((await s.ended(id)).status).toBe("completed");
    expect(s.spawns()).toEqual([s.head, s.base]);
  }, 120_000);

// Why (the coordinator's ruling, round 20): the readings wait on the head gate, so its read is
// waited on in Graph's slot (the gate counts as always waited on), while the reads' read alone is
// not. Each runs here by itself, sharing no run: behind a search holding the slot and background
// work queued before it, the gate's read goes first and the reads' read goes after that work.
for (const kind of ["gate", "reads"] as const)
  test(`the ${kind === "gate" ? "head gate's read is waited on in Graph's slot" : "reads' read alone is not waited on"}, with no run shared`, async () => {
    const s = await setup();
    s.mode("gated");
    const started: string[] = [];
    const { made, holders, open } = await gates(2);
    const [search, background] = made as [
      Deferred.Deferred<void>,
      Deferred.Deferred<void>,
    ];
    const reads = () => String(s.spawns().length);
    holders.push(holder(started, "search", search, () => true, reads));
    await until(() => started.length === 1, "the search to take the slot");
    holders.push(holder(started, "background", background, () => false, reads));
    await until(() => queued() === 1, "the background work to queue");
    const id = kind === "gate" ? await s.startGate() : await s.start();
    await until(() => queued() === 2, "the head's read to queue");
    await open(search);
    if (kind === "gate") {
      // Waited on: it went before the background work, which had not started when it ran.
      await until(() => s.spawns().includes(s.head), "the head's read");
      expect(started).toEqual(["search@0"]);
      s.release();
      await until(() => started.length === 2, "the background work");
      expect(started).toEqual(["search@0", "background@1"]);
    } else {
      await until(() => started.length === 2, "the background work");
      expect(started).toEqual(["search@0", "background@0"]);
      expect(s.spawns()).toEqual([]);
      s.release();
    }
    await open(background);
    expect((await s.ended(id)).status).toBe("completed");
    expect(s.spawns()).toEqual(kind === "gate" ? [s.head] : [s.head, s.base]);
  }, 120_000);

// Why (point 7 of the brief): what a finder's Graph search gets while the task's cold read holds
// Graph's one slot. It is modelled on `searchOnce` (graph-search.ts): the search queues in the slot
// as waited on while a caller waits for it, the caller stops at its own deadline with a pending
// answer while the search stays queued, now as background work, and runs once the read ends. A
// search whose caller is still waiting when the read ends goes before it, and before the base read.
test("a search meeting the task's read in Graph's slot waits for the read; past its deadline it is pending and runs after", async () => {
  const s = await setup();
  s.mode("gated");
  const id = await s.start();
  await until(
    () => s.spawns().includes(s.head),
    "the head's read to hold the slot",
  );
  const started: string[] = [];
  const reads = () => String(s.spawns().length);
  const { made, holders } = await gates(2);
  const [first, second] = made as [
    Deferred.Deferred<void>,
    Deferred.Deferred<void>,
  ];
  // The first search's caller waits a short deadline (standing for the review's 20 s).
  let waitingOnFirst = 1;
  holders.push(holder(started, "late", first, () => waitingOnFirst > 0, reads));
  await until(() => queued() === 1, "the first search to queue");
  // Its deadline passes, and its caller stops waiting (`GraphPending`): the slot never let the
  // search start, and it stays queued.
  await Bun.sleep(100);
  waitingOnFirst = 0;
  expect(started).toEqual([]);
  expect(queued()).toBe(1);
  // A second search whose caller is still waiting when the read ends.
  holders.push(holder(started, "waited", second, () => true, reads));
  await until(() => queued() === 2, "the second search to queue");
  await Effect.runPromise(Deferred.succeed(first, undefined));
  await Effect.runPromise(Deferred.succeed(second, undefined));
  s.release(s.head);
  await until(() => started.length === 2, "both searches to run");
  // The waited-on search first, then the one whose caller gave up, both before the base's read.
  expect(started).toEqual(["waited@1", "late@1"]);
  s.release();
  expect((await s.ended(id)).status).toBe("completed");
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

/** The rank the stage runner gives the review's own steps (`stageRunner`). */
const REVIEW_RANK: Priority = {
  class: "interactive",
  position: "understand",
  stage: 0,
};

// Why (the review's finding): nobody waits for the relations reads, so in the review's CPU budget
// they rank behind the review's own steps, as the leads do. With one grant held, the read asks for
// it first; review-ranked work asks after it; the grant goes to the review's work, and the engine
// starts only once that work releases it. The budget's clock is fixed, so waiting earns no rank and
// the order is the ranks' alone. A round that joins the read makes it waited on in Graph's slot, but
// its CPU request is the task's, made before the round came, and keeps the task's rank.
for (const joined of [false, true])
  test(`the read's CPU grant goes to review-ranked work first${joined ? ", also once a round joins it" : ""}`, async () => {
    const budget = new Scheduler(1, 1, undefined, undefined, () => 0);
    /** Every CPU request, by owner and rank, and whether it has its grant. */
    const asked: Array<{
      owner: string;
      priority: Priority;
      granted: boolean;
    }> = [];
    const admit = budget.admit.bind(budget);
    budget.admit = async (request, signal) => {
      const entry = {
        owner: request.owner,
        priority: request.priority,
        granted: false,
      };
      asked.push(entry);
      const grant = await admit(request, signal);
      entry.granted = true;
      return grant;
    };
    const reads = () => asked.filter((a) => a.owner === "graph.relations");
    const s = await setup({ budget });
    // The head index first, at the review's rank, so the task's wait for it finds it ready; and
    // the store's clone, so the read's first CPU request is its engine's.
    await s.headIndex();
    await Effect.runPromise(
      graphClone(s.repository, {
        executable: s.source.executable,
        workDirectory: relationsGraphDirectory(s.location),
      }),
    );
    const cpu = (owner: string) =>
      budget.admit({
        owner,
        priority: REVIEW_RANK,
        resource: { kind: "cpu", permits: 1 },
      });
    const waiting = async () => (await budget.observe())["waiting"] ?? 0;
    const blocker = await cpu("blocker");
    let blockerHeld = true;
    cleanups.push(async () => {
      if (blockerHeld) await blocker.release();
    });
    const id = await s.start();
    const deadline = Date.now() + 60_000;
    await until(() => reads().length === 1, "the head's read to ask for CPU");
    // The read holds Graph's slot and waits for its CPU grant, at the rank behind the review's
    // steps; its engine has not started, and it is the only request waiting.
    expect(reads()).toEqual([
      {
        owner: "graph.relations",
        priority: { class: "interactive", position: "new", stage: 0 },
        granted: false,
      },
    ]);
    expect(inUse()).toBe(1);
    expect(s.spawns()).toEqual([]);
    expect(await waiting()).toBe(1);
    let round: ReturnType<Setup["round"]> | undefined;
    if (joined) {
      round = s.round({ base: s.head, head: s.head });
      await until(
        () =>
          s.ops.filter((op) => op === "harness.graph-relations").length === 2,
        "the round to ask for the head's relations",
      );
      await setImmediate();
      // It joined the read: no second request for CPU or the slot.
      expect(await waiting()).toBe(1);
    }
    const review = cpu("review");
    while ((await waiting()) < 2) {
      if (Date.now() > deadline)
        throw new Error("the review's work never asked");
      await Bun.sleep(5);
    }
    blockerHeld = false;
    await blocker.release();
    const granted = await review;
    // The review's work has the grant; the read still waits for it.
    expect(s.spawns()).toEqual([]);
    expect(await waiting()).toBe(1);
    await granted.release();
    expect(await s.ended(id)).toMatchObject({
      status: "completed",
      result: { status: "stored" },
    });
    expect(s.spawns()).toEqual([s.head, s.base]);
    if (round !== undefined) expect((await round).outcomes.head).toBe("shared");
  }, 120_000);

// Why (the review's finding; the defect the timeline lane fixed for the leads): only the reads rank
// behind the review. The head index's build is the one the finders' `uses` and `defs` wait for, so
// it must keep the review's rank even when this task is its first caller, as it is with no leads
// task. With nothing built before, every CPU request before the first read's (the head index's
// build) is at the stage runner's rank, and the clone's and the two reads' are at the lowered one.
test("with no leads task, the head index this task starts is built at the review's rank, and only the clone and the reads rank behind it", async () => {
  const budget = new Scheduler(1, 1, undefined, undefined, () => 0);
  /** Every CPU request, in the order made, by owner and rank. */
  const asked: Array<{ owner: string; priority: Priority }> = [];
  const admit = budget.admit.bind(budget);
  budget.admit = (request, signal) => {
    asked.push({ owner: request.owner, priority: request.priority });
    return admit(request, signal);
  };
  const s = await setup({ budget });
  expect(await s.ended(await s.start())).toMatchObject({
    status: "completed",
    result: { status: "stored" },
  });
  const BEHIND: Priority = { class: "interactive", position: "new", stage: 0 };
  const firstRead = asked.findIndex((a) => a.owner === "graph.relations");
  expect(firstRead).toBeGreaterThan(0);
  const index = asked
    .slice(0, firstRead)
    .filter((a) => a.owner !== "graph.clone");
  // The head index's build asked for CPU, all of it at the review's rank.
  expect(index.length).toBeGreaterThan(0);
  expect(index.map((a) => a.priority)).toEqual(index.map(() => REVIEW_RANK));
  const lowered = asked.filter(
    (a) => a.owner === "graph.clone" || a.owner === "graph.relations",
  );
  expect(lowered.map((a) => a.owner)).toEqual([
    "graph.clone",
    "graph.relations",
    "graph.relations",
  ]);
  expect(lowered.map((a) => a.priority)).toEqual(lowered.map(() => BEHIND));
  // Nothing else asked for CPU after the first read.
  expect(asked.slice(firstRead).every((a) => lowered.includes(a))).toBe(true);
}, 120_000);

// Why: no failure of the relations may fail or delay the review: each ends the task `completed`,
// with the failed side's gap, and what worked stored.
test("an engine without the capability completes the task with graph-unavailable sides", async () => {
  const s = await setup({ capable: false });
  const outcome = await s.ended(await s.start());
  expect(outcome).toMatchObject({
    status: "completed",
    result: {
      status: "failed",
      head: { commit: s.head, outcome: "graph-unavailable" },
      base: { commit: s.base, outcome: "graph-unavailable" },
    },
  });
  expect(s.spawns()).toEqual([]);
}, 120_000);

test("no engine at all completes the task with graph-unavailable sides and waits for nothing", async () => {
  const s = await setup();
  process.env[ENGINE] = join(s.root, "absent-engine");
  const outcome = await s.ended(await s.start());
  expect(outcome).toMatchObject({
    status: "completed",
    result: {
      status: "failed",
      head: { outcome: "graph-unavailable", wallMs: 0 },
      base: { outcome: "graph-unavailable", wallMs: 0 },
    },
  });
  expect(s.ops).not.toContain("held-chunks");
}, 120_000);

test("a failed read completes the task as failed, with the failure's tag and nothing stored", async () => {
  const s = await setup();
  s.mode("fail");
  const outcome = await s.ended(await s.start());
  expect(outcome).toMatchObject({
    status: "completed",
    result: {
      status: "failed",
      head: { outcome: "failed", error: "command" },
      base: { outcome: "failed", error: "command" },
    },
  });
  expect(rows(s).map((r) => [r["side"], r["outcome"], r["error"]])).toEqual([
    ["head", "failed", "command"],
    ["base", "failed", "command"],
  ]);
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
}, 120_000);

test("a failed base read keeps the stored head", async () => {
  const s = await setup();
  s.mode("gated");
  const id = await s.start();
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  // The engine reads its mode as it starts: the head's ends valid, the base's fails.
  s.mode("fail");
  s.release(s.head);
  expect(await s.ended(id)).toMatchObject({
    status: "completed",
    result: {
      status: "failed",
      head: { outcome: "computed" },
      base: { outcome: "failed", error: "command" },
    },
  });
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  expect(Option.isNone(await s.stored(s.base))).toBe(true);
}, 120_000);

test("a clone that cannot be made completes the task as failed with tag clone", async () => {
  const s = await setup();
  // A file where the store's Graph folder should be: the clone's folder cannot be made.
  mkdirSync(join(s.location.directory), { recursive: true });
  writeFileSync(relationsGraphDirectory(s.location), "");
  const outcome = await s.ended(await s.start());
  expect(outcome).toMatchObject({
    status: "completed",
    result: {
      status: "failed",
      head: { outcome: "failed", error: "clone" },
      base: { outcome: "failed", error: "clone" },
    },
  });
  expect(s.spawns()).toEqual([]);
}, 120_000);

test("a manifest that cannot be read completes the task as failed", async () => {
  const s = await setup();
  const outcome = await s.ended(await s.start(600_000, "0".repeat(64)));
  expect(outcome).toMatchObject({
    status: "completed",
    result: { status: "failed", detail: expect.any(String) },
  });
  expect(rows(s)).toEqual([
    expect.objectContaining({
      type: "range.relations",
      outcome: "failed",
    }),
  ]);
  expect(s.spawns()).toEqual([]);
}, 120_000);

// --- The head gate (NEU-148 round 20) -------------------------------------------------------------

// Why: the readings wait on the gate, so its cut-off is their bound: the earlier of the review's
// cut-off and the review's start plus the bound, from the run clock, fixed in the gate's input as it
// is created (a restart reads the input, never the clock again).
test("the head gate's cut-off is the earlier of the review's cut-off and the run's start plus the bound", async () => {
  const startedAt = 1_000_000;
  const task = relationsTask({} as StageServices);
  /** What the starter creates, through a transaction that only records the call. */
  const created = async (cutoffAt: number) => {
    const calls: unknown[] = [];
    const tx = {
      createTask: async (...args: unknown[]) => {
        calls.push(args.slice(1));
        return 7 as unknown as TaskId;
      },
    } as unknown as Tx;
    await headGateOf(task, { startedAt })(
      tx,
      { manifest: "m", cutoffAt },
      3 as unknown as TaskId,
    );
    return calls;
  };
  const owned = { ownership: { kind: "task", taskId: 3 } };
  expect(await created(startedAt + 550_000)).toEqual([
    [
      {
        manifest: "m",
        cutoffAt: startedAt + HEAD_GATE_BOUND_MS,
        headGate: true,
      },
      owned,
    ],
  ]);
  expect(await created(startedAt + 60_000)).toEqual([
    [{ manifest: "m", cutoffAt: startedAt + 60_000, headGate: true }, owned],
  ]);
});

// Why (the addendum's shape): the gate and the reads are two tasks over one run per key (record
// 0016): one engine run of the head, whichever subscribed first. At the gate's bound only its own
// subscription goes: the gate ends `cutoff` with the wall time its read had run, a reading waiting on
// it wakes, and the reads keep the head's run going, store it, and go on to the base, to the review's
// cut-off.
test("at its bound the gate ends and wakes its waiter, while the reads keep the head's read and store it", async () => {
  const s = await setup({ gateBoundMs: 2_000 });
  s.mode("gated");
  const review = await s.startReview();
  const reads = await s.childOf(review);
  const gate = await s.gateOf(review);
  const waiter = await s.waitOn(gate);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  expect(await s.ended(gate)).toEqual({
    status: "completed",
    result: {
      status: "cutoff",
      head: {
        commit: s.head,
        key: s.keyOf(s.head),
        outcome: "cutoff",
        wallMs: expect.any(Number),
      },
      detail:
        "the gate's cut-off (the readings' bound or the review's) came first",
    },
  });
  // Its read had started: the wall time says so (0 would say the index was still being built).
  expect(
    ((await s.ended(gate)) as { result: RelationsResult }).result.head?.wallMs,
  ).toBeGreaterThan(0);
  expect(await s.woke(waiter)).toEqual({
    status: "completed",
    result: { outcome: "completed", status: "cutoff" },
  });
  // The reads still hold the head's run, and the review holds as completing for them.
  expect(inUse()).toBe(1);
  expect((await s.harness.getTask(reads, context))?.state.status).not.toBe(
    "terminal",
  );
  s.release();
  expect(await s.ended(reads)).toMatchObject({
    status: "completed",
    result: {
      status: "stored",
      head: { outcome: expect.stringMatching(/^(computed|shared)$/) },
      base: { outcome: "computed" },
    },
  });
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  // One engine run of the head for both subscribers.
  expect(s.spawns()).toEqual([s.head, s.base]);
  // The gate's rows say they are the gate's; the reads' rows are as before.
  expect(rows(s).filter((r) => r["headGate"] === true)).toEqual([
    expect.objectContaining({ side: "head", outcome: "cutoff" }),
  ]);
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
}, 120_000);

// Why: a reading waiting on the gate must wake however the gate ends, and see how: its head stored,
// failed, cut off at the bound before its read started (the head index still being built), or
// stopped. (Published is in the next test.)
for (const end of ["stored", "failed", "cutoff", "stopped"] as const)
  test(`a waiter on the gate wakes when the gate ends ${end}`, async () => {
    const chunks = heldChunks("computes");
    const s = await setup(end === "cutoff" ? { chunks: chunks.wrap } : {});
    if (end === "failed") s.mode("fail");
    if (end === "stopped") s.mode("gated");
    const gate = await s.startGate(end === "cutoff" ? 1_000 : 600_000);
    const waiter = await s.waitOn(gate);
    if (end === "stopped") {
      await until(
        () => s.spawns().includes(s.head),
        "the head engine to start",
      );
      expect(await s.waiterStatus(waiter)).toBe("waiting");
      await s.harness.abortTask(gate, context);
    }
    expect(await s.woke(waiter)).toEqual({
      status: "completed",
      result:
        end === "stopped"
          ? { outcome: "aborted", status: "stopped" }
          : { outcome: "completed", status: end },
    });
    const gateEnd = await s.ended(gate);
    if (end === "cutoff")
      // Cut off before its read started: wall time 0, and no engine.
      expect(gateEnd).toMatchObject({
        result: { head: { outcome: "cutoff", wallMs: 0 } },
      });
    if (end === "stored")
      expect(gateEnd).toMatchObject({
        result: { head: { outcome: "computed" } },
      });
    // The gate reads the head alone.
    expect(
      (gateEnd as { result?: RelationsResult }).result?.base,
    ).toBeUndefined();
    expect(s.spawns()).toEqual(
      end === "cutoff" ? [] : end === "stopped" ? [s.head] : [s.head],
    );
  }, 120_000);

// Why (round 19 for both tasks): once the packet is published both stop their unfinished reads and
// end `published`, a waiter on the gate wakes, and the review is terminal at once. A read the two
// alone subscribed to is withdrawn; nothing is stored for it.
test("a review published while the gate and the reads share the head's read ends both, and the read is withdrawn", async () => {
  const s = await setup({ gateBoundMs: 600_000 });
  s.mode("gated");
  const review = await s.startReview();
  const reads = await s.childOf(review);
  const gate = await s.gateOf(review);
  const waiter = await s.waitOn(gate);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  // Both subscribed: the second asked the store for the head's relations too.
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 2,
    "both to ask for the head's relations",
  );
  await setImmediate();
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect(await s.ended(gate)).toMatchObject({
    status: "completed",
    result: { status: "published", head: { outcome: "published" } },
  });
  expect(await s.ended(reads)).toMatchObject({
    status: "completed",
    result: {
      status: "published",
      head: { outcome: "published" },
      base: { outcome: "published", wallMs: 0 },
    },
  });
  expect(await s.woke(waiter)).toEqual({
    status: "completed",
    result: { outcome: "completed", status: "published" },
  });
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (record 0016): a read a consumer's round also subscribed to is the round's too: the published
// packet ends the gate and the reads, and the head's read runs on for the round, which gets it.
test("a review published while a round shares the head's read with the gate and the reads leaves the read running for the round", async () => {
  const s = await setup({ gateBoundMs: 600_000 });
  s.mode("gated");
  const review = await s.startReview();
  const gate = await s.gateOf(review);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  const joined = s.round({ base: s.head, head: s.head });
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 3,
    "the reads, the gate and the round to ask for the head's relations",
  );
  await setImmediate();
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect((await s.ended(gate)) as { result: RelationsResult }).toMatchObject({
    result: { status: "published" },
  });
  expect(inUse()).toBe(1);
  s.release();
  expect((await joined).outcomes.head).toBe("shared");
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why: a stopped review aborts the work it owns: the gate and the reads both commit `stopped`, the
// read they alone subscribed to is withdrawn, and a waiter on the gate wakes.
test("a stopped review stops the gate and the reads, and withdraws their read", async () => {
  const s = await setup({ gateBoundMs: 600_000 });
  s.mode("gated");
  const review = await s.startReview();
  const reads = await s.childOf(review);
  const gate = await s.gateOf(review);
  const waiter = await s.waitOn(gate);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  await s.harness.abortTask(review, context);
  const stopped = {
    status: "aborted",
    reason: "stopped",
    result: { status: "stopped" },
  } as const;
  expect(await s.ended(gate)).toEqual(stopped);
  expect(await s.ended(reads)).toEqual(stopped);
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("aborted");
  expect(await s.woke(waiter)).toEqual({
    status: "completed",
    result: { outcome: "aborted", status: "stopped" },
  });
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// --- A read past the review's cut-off (NEU-148 round 22) ------------------------------------------

/** The review's cut-off in these tests: after the head's read has started (its index built first). */
const CUT_MS = 3_000;
const inFlightNow = () => Effect.runSync(relationsReadsInFlight);
const continuedRows = (s: Setup) =>
  rows(s).filter((r) => r["continued"] === true);

// Why (the gates lane's measure): on long repositories the head's read outlasts the review, and
// withdrawn at the cut-off it was never stored. In flight at the cut-off it goes on past the task's
// end and the packet published after the cut-off, counted in flight (what the worker's exit rule
// reads, `detachedWork`), is stored when the engine ends, and a later round finds it stored with no
// second engine. The base, not started, is not started.
test("a read in flight at the review's cut-off goes on past the task and the packet, counted in flight, and is stored for a later round", async () => {
  const s = await setup();
  await s.headIndex();
  s.mode("gated");
  const review = await s.startReview(CUT_MS);
  const id = await s.childOf(review);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  const head = {
    commit: s.head,
    key: s.keyOf(s.head),
    outcome: "continued" as const,
    wallMs: expect.any(Number),
  };
  const base = {
    commit: s.base,
    key: s.keyOf(s.base),
    outcome: "cutoff" as const,
    wallMs: 0,
  };
  expect(await s.ended(id)).toEqual({
    status: "completed",
    result: {
      status: "cutoff",
      head,
      base,
      detail: "the review's cut-off came first",
    },
  });
  // The task has ended; the read goes on, in Graph's slot and counted in flight.
  expect(inUse()).toBe(1);
  expect(inFlightNow()).toBe(1);
  s.publish();
  expect(
    (await s.harness.waitForTask(review, context)).state.outcome.status,
  ).toBe("completed");
  expect(inUse()).toBe(1);
  expect(inFlightNow()).toBe(1);
  expect(rows(s)).toEqual([
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "head",
      ...head,
      boundMs: CONTINUED_READ_BOUND_MS,
    },
    { type: "range.relations", manifest: s.manifestKey, side: "base", ...base },
  ]);
  s.release();
  await until(() => inFlightNow() === 0, "the read that went on to end");
  expect(continuedRows(s)).toEqual([
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "head",
      continued: true,
      commit: s.head,
      key: s.keyOf(s.head),
      outcome: "computed",
      wallMs: expect.any(Number),
      records: 8,
      afterCutoffMs: expect.any(Number),
    },
  ]);
  expect(Option.isSome(await s.stored(s.head))).toBe(true);
  expect(Option.isNone(await s.stored(s.base))).toBe(true);
  const after = await s.round({ base: s.head, head: s.head });
  expect(after.outcomes.head).toBe("stored");
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (record 0016): the read that went on is the same shared run under its key: a later review's
// reads join it, with no second engine, and go on to the base; the run's first subscriber, the one
// that went on, is the one that computed it.
test("a later review's reads join the read that went on past the cut-off", async () => {
  const s = await setup();
  await s.headIndex();
  s.mode("gated");
  const first = await s.start(CUT_MS);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  expect(await s.ended(first)).toMatchObject({
    result: { status: "cutoff", head: { outcome: "continued" } },
  });
  const later = await s.start();
  await until(
    () => s.ops.filter((op) => op === "harness.graph-relations").length === 2,
    "the later reads to ask for the head's relations",
  );
  await setImmediate();
  expect(s.spawns()).toEqual([s.head]);
  s.release();
  expect(await s.ended(later)).toMatchObject({
    status: "completed",
    result: {
      status: "stored",
      head: { outcome: "shared" },
      base: { outcome: "computed" },
    },
  });
  await until(() => inFlightNow() === 0, "the read that went on to end");
  expect(continuedRows(s)).toEqual([
    expect.objectContaining({ side: "head", outcome: "computed" }),
  ]);
  expect(s.spawns()).toEqual([s.head, s.base]);
}, 120_000);

// Why: the read that goes on has a bound of its own, from its start: still running at it and the
// run's last subscriber, it is withdrawn as at a stop, nothing is stored (the next review reads from
// zero), the count in flight goes back, and its row says `bound`.
test("at its own bound the read that went on is withdrawn when no other caller subscribed", async () => {
  const bound = CUT_MS + 1_500;
  const s = await setup({ continuedReadBoundMs: bound });
  await s.headIndex();
  s.mode("gated");
  const id = await s.start(CUT_MS);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  expect(await s.ended(id)).toMatchObject({
    result: { status: "cutoff", head: { outcome: "continued" } },
  });
  expect(inFlightNow()).toBe(1);
  await until(() => inFlightNow() === 0, "the read's own bound");
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  expect(continuedRows(s)).toEqual([
    {
      type: "range.relations",
      manifest: s.manifestKey,
      side: "head",
      continued: true,
      commit: s.head,
      key: s.keyOf(s.head),
      outcome: "bound",
      wallMs: expect.any(Number),
      afterCutoffMs: expect.any(Number),
    },
  ]);
  // Timers fire at or after their time; a millisecond of rounding either way.
  expect(continuedRows(s)[0]?.["wallMs"]).toBeGreaterThanOrEqual(bound - 2);
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (the coordinator's ruling): before the cut-off, the review's packet and its stop still stop
// the read the task alone subscribed to: nothing goes on (the read leaves Graph's slot without its
// engine being released), nothing is counted in flight, nothing is stored.
for (const end of ["published", "stopped"] as const)
  test(`a review ${end} before its cut-off leaves no read going on`, async () => {
    const s = await setup();
    s.mode("gated");
    const review = await s.startReview();
    const id = await s.childOf(review);
    await until(() => s.spawns().includes(s.head), "the head engine to start");
    if (end === "published") s.publish();
    else await s.harness.abortTask(review, context);
    expect(await s.ended(id)).toMatchObject(
      end === "published"
        ? { status: "completed", result: { head: { outcome: "published" } } }
        : { status: "aborted", result: { status: "stopped" } },
    );
    await until(() => inUse() === 0, "the read to leave Graph's slot");
    expect(inFlightNow()).toBe(0);
    expect(rows(s).filter((r) => r["outcome"] === "continued")).toEqual([]);
    expect(continuedRows(s)).toEqual([]);
    s.release();
    expect(Option.isNone(await s.stored(s.head))).toBe(true);
    expect(s.spawns()).toEqual([s.head]);
  }, 120_000);

// Why (the brief's point 1): the head gate's bound does not change: at it only its subscription
// goes, so a read the gate alone subscribed to is withdrawn and nothing goes on.
test("the head gate at its bound continues nothing: a read it alone subscribed to is withdrawn", async () => {
  const s = await setup();
  await s.headIndex();
  s.mode("gated");
  const gate = await s.startGate(CUT_MS);
  await until(() => s.spawns().includes(s.head), "the head engine to start");
  expect(await s.ended(gate)).toMatchObject({
    result: { status: "cutoff", head: { outcome: "cutoff" } },
  });
  await until(() => inUse() === 0, "the read to leave Graph's slot");
  expect(inFlightNow()).toBe(0);
  expect(continuedRows(s)).toEqual([]);
  s.release();
  expect(Option.isNone(await s.stored(s.head))).toBe(true);
  expect(s.spawns()).toEqual([s.head]);
}, 120_000);

// Why (the coordinator's condition): the review is given the starter only when the run's frozen
// configuration has the readings setting, while the task is registered either way, so a stored
// checkpoint that names one resumes.
test("the stages always provide the relations starter and head gate", async () => {
  const s = await setup();
  const stages = reviewStages({ ...s.services, registry: createRegistry() });
  expect(typeof stages.relations).toBe("function");
  expect(typeof stages.headGate).toBe("function");
  expect(stages.extension.tasks?.map((task) => task.definition.name)).toContain(
    RELATIONS_TASK,
  );
});

const realSource = captureOutlineSource();
const realCapable = (() => {
  if (!("sha256" in realSource.key)) return false;
  const result = Bun.spawnSync(
    [realSource.executable, "capabilities", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.toString()) as {
      optional_local_only_features?: { exact_commit_bulk_streams?: unknown };
    };
    return (
      parsed.optional_local_only_features?.exact_commit_bulk_streams === true
    );
  } catch {
    return false;
  }
})();
const realGraph = graphTestPrerequisite({
  available: realCapable,
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must declare exact_commit_bulk_streams. Run `bun run build:graph` from the workspace root.",
});

// Why: the whole path on the real engine: the task's work on a small repository stores both sides,
// each read once, and a consumer's round afterwards reads both stored.
test.skipIf(realGraph.skip)(
  "on the real engine the task stores both sides once each, and a round afterwards reads both stored",
  async () => {
    realGraph.require();
    const s = await setup({ real: true });
    expect(s.source.executable).toBe(realSource.executable);
    const outcome = await s.ended(await s.start());
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "stored",
        head: { commit: s.head, key: s.keyOf(s.head), outcome: "computed" },
        base: { commit: s.base, key: s.keyOf(s.base), outcome: "computed" },
      },
    });
    const after = await s.round({ base: s.base, head: s.head });
    expect(after.outcomes).toEqual({ base: "stored", head: "stored" });
    expect(s.computed).toEqual([s.head, s.base]);
  },
  180_000,
);
