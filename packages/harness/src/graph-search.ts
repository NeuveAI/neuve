import { CpuWork, cpuWork } from "./budget/cpu.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Metric,
  Option,
  Semaphore,
} from "effect";
import {
  prepareGraphSnapshot,
  runGraphInspection,
  type GraphCommandUsage,
  type GraphQueryObservation,
  type GraphServiceStats,
  type GraphStoreUsage,
} from "@neuve/graph-client";
import { Worker } from "@neuve/records-core";
import { estimateTokens } from "./budget.ts";
import { CHUNK_RECIPE, WINDOW_RECIPE, splitLines } from "./chunker.ts";
import { git } from "./git.ts";
import { lsTree, readBlobs } from "./git-objects.ts";
import type {
  GraphConfig,
  RetrievalAnswer,
  Retriever,
  SearchResult,
} from "./retriever.ts";
import {
  chunkIdOf,
  chunkIdentifiers,
  indexRecipe,
  specificIdentifiers,
  type IndexedChunk,
  type TreeIndex,
} from "./search-index.ts";
import {
  SharedWork,
  KeyHeld,
  type PublishedSharedOutcome,
} from "@neuve/records-core/shared-work";
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect";
import {
  canonicalStoreIdentity,
  sharedWorkSocket,
} from "@neuve/records-core/shared-work-socket";
import { z } from "zod";
import { reorderByKind } from "./retriever.ts";
import { METRICS, secondsBetween, recordLate, spanClock } from "./telemetry.ts";

/**
 * Graph's semantic query behind the retriever port (10.89): the question goes unchanged through
 * `@neuve/graph-client`, the one validated boundary to Neuve Graph, to the fork (9.62) reading a
 * complete full-profile snapshot of the range's base commit, as the benchmark's G-fork arm and H3's
 * Graph input did (`packages/evaluation/src/retrieval-bench/graph.ts`). Only `query` is used: no
 * relationship plan and no structural lookup (10.10). Results are normalised observations only;
 * nothing here parses a Graph receipt.
 *
 * Graph reads a private clone of the repository (`git clone --shared --no-checkout` under the
 * store's `graph/` folder: objects through alternates, no files checked out), because the engine
 * indexes the commit at HEAD and preparing moves that clone's HEAD, never the repository's. It runs
 * under 6.10's bounds: one Graph process at a time (a query or a preparation), `git grep` and the engine at two threads each, one
 * preparation at a time per clone, and every query aborted at its deadline.
 */

export const GRAPH_LIMITS = { maxContextBytes: 8 * 1024 * 1024 } as const;
/** A preparation past this is aborted (bench preparations took 2-66 s idle, 171 s at load 45). */
export const GRAPH_PREPARE_DEADLINE_MS = 300_000;
/**
 * Politeness (6.10): one Graph process at a time, as the M3 proposal's isolation and bounded-CPU
 * default ruled (10.77, section 3.8), with `git grep` and the Go engine at two threads each (the
 * engine's cap is graph-client's `GRAPH_ENGINE_GO_MAX_PROCS`, one value for every Neuve process).
 */
export const GRAPH_POLITE = {
  queries: 1,
  /**
   * Graph calls at once while the shared Graph service answers: it runs two reads, so a second
   * search need not wait behind the first. One again when the service is off, and the engine runs
   * in this process's own child.
   */
  serviceReads: 2,
  grepThreads: 2,
  /** The engine and its `git grep` run at nice 10, as every heavy subprocess does (section 3.8). */
  niceness: 10,
} as const;

/**
 * Span events on a Graph search's own work (`GRAPH_SEARCH_SPAN`): the base's snapshot is ready,
 * after waiting for or making its preparation; the query slot is taken, with the wait for it. The
 * work's start, these and its end split it into preparation wait, slot wait and Graph's own run,
 * which its `harness.graph.*` attributes break down further.
 */
export const GRAPH_EVENTS = {
  baseReady: "harness.graph.base_ready",
  slotTaken: "harness.graph.slot_taken",
} as const;

export interface GraphRuntime {
  readonly executable: string;
  /** Clones, temporary views and, unless `cacheDirectory` says otherwise, the cache (`<store>/graph`). */
  readonly workDirectory: string;
  /**
   * Graph's cache when it is not `<workDirectory>/cache`: the commit-time process keeps its own
   * clone but shares the store's one Graph cache, which Graph makes safe for several processes.
   */
  readonly cacheDirectory?: string;
}

export class GraphUnavailable extends Error {
  readonly _tag = "GraphUnavailable";
}

/**
 * The engine's slots in this process: one Graph call at a time (`GRAPH_POLITE.queries`), or as
 * many as the shared service runs reads at once while it answers (`GRAPH_POLITE.serviceReads`), as
 * the last call found it. A queue with two classes (architecture record 0013): when a slot frees,
 * the oldest waiting search that a caller is still waiting on goes first, then the oldest of the
 * rest. Each waiter's class is read when a slot frees, so a search its callers stopped waiting on
 * falls back, and one an agent asks for again moves up. A base's preparation is waited on exactly
 * when one of the calls that asked for it is (`prepareBase`).
 */
const slot = {
  inUse: 0,
  capacity: GRAPH_POLITE.queries as number,
  waiting: [] as Array<{
    readonly urgent: () => boolean;
    readonly wake: Deferred.Deferred<void>;
    woken: boolean;
  }>,
};

/** Wakes the next waiter, waited-on first, into a slot it now holds; false when none waits. */
const wakeNext = () => {
  const at = slot.waiting.findIndex((entry) => entry.urgent());
  const next = slot.waiting.splice(at === -1 ? 0 : at, 1)[0];
  if (next === undefined) return false;
  next.woken = true;
  Deferred.doneUnsafe(next.wake, Exit.void);
  return true;
};

/** A slot freed: passed to the next waiter while within capacity, else given back. */
const releaseSlot = () => {
  if (slot.inUse > slot.capacity || !wakeNext()) slot.inUse--;
};

/**
 * The slots the service's answer allows: its reads at once while it answers, one otherwise. Slots
 * a raise opens go to the waiters at once; a lowering takes effect as calls end.
 */
const observeService = (answered: boolean | undefined) => {
  if (answered === undefined) return;
  slot.capacity = answered ? GRAPH_POLITE.serviceReads : GRAPH_POLITE.queries;
  while (slot.inUse < slot.capacity && wakeNext()) slot.inUse++;
};

/**
 * Entry admission happens before taking the shared slot, which is released on every exit.
 * Launches inside this admitted Graph work are not re-gated when a later review starts.
 * Graph per-launch admission is a follow-up requiring release/reacquire of the slot and clone lock.
 */
const withSlot =
  (urgent: () => boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Worker.HeavyWork, (gate) =>
      gate.start(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (slot.inUse < slot.capacity) slot.inUse++;
            else {
              const entry = {
                urgent,
                wake: Deferred.makeUnsafe<void>(),
                woken: false,
              };
              slot.waiting.push(entry);
              yield* restore(Deferred.await(entry.wake)).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    const at = slot.waiting.indexOf(entry);
                    if (at !== -1) slot.waiting.splice(at, 1);
                    // Woken as it was interrupted: the slot is its to pass on.
                    else if (entry.woken) releaseSlot();
                  }),
                ),
              );
            }
            return yield* restore(effect).pipe(
              Effect.ensuring(Effect.sync(releaseSlot)),
            );
          }),
        ).pipe(
          Effect.provideService(
            Worker.HeavyWork,
            Worker.HeavyWork.defaultValue(),
          ),
        ),
      ),
    );
/** The Graph slot for other engine callers in this process, which take the same slot (record 0013). */
export const withGraphSlot = withSlot;
/** The slots, for tests of their order and capacity only. */
export const slotsForTests = {
  withSlot,
  observeService,
  state: () => ({
    inUse: slot.inUse,
    capacity: slot.capacity,
    waiting: slot.waiting.length,
  }),
};

/** This process's Graph searches waiting or running, and since when one has been (`graphBusy`). */
const busy = { searches: 0, since: 0n };
const clones = new Map<string, Semaphore.Semaphore>();

const sha12 = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

const cloneWork = new SharedWork<string, GraphUnavailable>();
const CloneFailure = z.object({ message: z.string() });

/** Publish the complete clone before releasing its machine-wide claim. */
export const graphClone = (repository: string, runtime: GraphRuntime) =>
  Effect.flatMap(Worker.HeavyWork, (gate) =>
    gate.start(
      Effect.gen(function* () {
        const repositoryId = yield* Effect.promise(() =>
          canonicalStoreIdentity(repository),
        );
        const directory = yield* Effect.try({
          try: () => {
            mkdirSync(runtime.workDirectory, { recursive: true });
            return realpathSync(runtime.workDirectory);
          },
          catch: (cause) => new GraphUnavailable(String(cause)),
        });
        const clone = join(directory, "clones", sha12(repositoryId));
        const outcomes = join(directory, "clone-outcomes", sha12(repositoryId));
        const ready = () =>
          existsSync(join(clone, "HEAD")) || existsSync(join(clone, ".git"));
        const read = async (
          publication?: string,
        ): Promise<
          PublishedSharedOutcome<string, GraphUnavailable> | undefined
        > => {
          if (publication === undefined || publication === "clone")
            return ready()
              ? {
                  publication: "clone",
                  outcome: { kind: "succeeded", value: clone },
                }
              : undefined;
          // The publication is an immutable attempt id, never a path supplied by a peer.
          if (!z.uuid().safeParse(publication).success) return undefined;
          const path = join(outcomes, publication);
          if (!existsSync(path)) return undefined;
          const failure = CloneFailure.parse(
            JSON.parse(readFileSync(path, "utf8")),
          );
          return {
            publication,
            outcome: {
              kind: "failed",
              error: new GraphUnavailable(failure.message),
            },
          };
        };
        const { value } = yield* sharedWorkEffect(cloneWork, {
          scope: directory,
          key: `graph-clone@1\0${repositoryId}\0${directory}`,
          crossProcess: {
            store: directory,
            transport: sharedWorkSocket(),
            read,
          },
          run: () =>
            Effect.gen(function* () {
              const publication = randomUUID();
              const temporary = `${clone}.${publication}`;
              const exit = yield* Effect.exit(
                Effect.gen(function* () {
                  yield* Effect.sync(() =>
                    mkdirSync(join(directory, "clones"), { recursive: true }),
                  );
                  yield* git(
                    repository,
                    [
                      "clone",
                      "--quiet",
                      "--shared",
                      "--no-checkout",
                      repository,
                      temporary,
                    ],
                    { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
                  );
                  yield* git(temporary, [
                    "config",
                    "grep.threads",
                    String(GRAPH_POLITE.grepThreads),
                  ]);
                  yield* Effect.sync(() => {
                    // At the disclosed floor another process may have published first.
                    if (!ready()) renameSync(temporary, clone);
                  });
                }).pipe(
                  (work) => cpuWork("graph.clone", work),
                  Effect.ensuring(
                    Effect.sync(() =>
                      rmSync(temporary, { recursive: true, force: true }),
                    ),
                  ),
                ),
              );
              if (Exit.isSuccess(exit))
                return {
                  publication: "clone",
                  outcome: { kind: "succeeded", value: clone },
                } satisfies PublishedSharedOutcome<string, GraphUnavailable>;
              const message = String(Cause.squash(exit.cause));
              // Failure publication errors close ownership without a done notification.
              yield* Effect.sync(() => {
                mkdirSync(outcomes, { recursive: true, mode: 0o700 });
                const path = join(outcomes, publication);
                writeFileSync(`${path}.tmp`, JSON.stringify({ message }), {
                  mode: 0o600,
                });
                renameSync(`${path}.tmp`, path);
              });
              return {
                publication,
                outcome: {
                  kind: "failed",
                  error: new GraphUnavailable(message),
                },
              } satisfies PublishedSharedOutcome<string, GraphUnavailable>;
            }),
        }).pipe(Effect.catchTag("SharedWorkError", Effect.die));
        return value;
      }).pipe(
        Effect.provideService(
          Worker.HeavyWork,
          Worker.HeavyWork.defaultValue(),
        ),
      ),
    ),
  );

const cacheDirectory = (runtime: GraphRuntime) =>
  runtime.cacheDirectory ?? join(runtime.workDirectory, "cache");
const temporaryParent = (runtime: GraphRuntime) => {
  const directory = join(runtime.workDirectory, "tmp");
  mkdirSync(directory, { recursive: true });
  return directory;
};

/** Base preparations running in this process, whoever started them (a search, or a prewarm). */
let preparing = 0;

/** Who asked for each preparation still under way, by their urgency (`prepareBase`). */
const preparationAskers = new Map<string, Set<() => boolean>>();

const preparations = new Map<
  string,
  Promise<{
    clone: string;
    millis: number;
    cache: string;
    files: number | null;
    store: GraphStoreUsage | undefined;
    /** What the preparation used and the shared service's block for it, as span attributes. */
    attributes: Record<string, string | number | boolean>;
  }>
>();

/**
 * Prepares the base commit's complete full-profile snapshot once (the engine's cache keeps it):
 * points the clone's HEAD at the commit, then `prepareGraphSnapshot`, one per clone at a time. It
 * runs detached from any one search, so a search that reaches its deadline while the base is still
 * preparing never cancels the preparation the next search waits on; a failed one is tried again.
 * It has a deadline of its own (`GRAPH_PREPARE_DEADLINE_MS`), so a hung engine frees the single
 * Graph slot. Admission uses the caller's gate before registering shared preparation. The detached
 * work uses that admission until it releases the clone lock and Graph slot; it never waits at the
 * review gate while a review can join it. The engine that prepared must be the one the run is keyed on (`engine.sha256`).
 */
export const prepareBase = (
  repository: string,
  commit: string,
  runtime: GraphRuntime,
  engineSha256: string,
  /**
   * Whether this caller is waiting on the preparation now: a search's own class, a review's
   * warm-up; never for commit time's preparation of the next base, which nobody waits on yet.
   */
  urgent: () => boolean = () => true,
) =>
  Effect.gen(function* () {
    const gate = yield* Worker.HeavyWork;
    const environment = yield* Effect.context<never>();
    return yield* gate.start(
      Effect.tryPromise({
        try: () => {
          const key = `${repository}\0${commit}\0${runtime.workDirectory}\0${engineSha256}`;
          // The preparation is waited on while any caller who asked for it is.
          let askers = preparationAskers.get(key);
          if (askers === undefined)
            preparationAskers.set(key, (askers = new Set()));
          const asked = askers;
          asked.add(urgent);
          let held = preparations.get(key);
          // Whether this call started the preparation, rather than finding it prepared or under way.
          const made = held === undefined;
          if (held === undefined) {
            held = Effect.runPromiseExit(
              Effect.gen(function* () {
                const usage: GraphUsage = {
                  commands: 0,
                  wallMs: 0,
                  userMs: 0,
                  systemMs: 0,
                  cpuUnreported: 0,
                };
                const clone = yield* graphClone(repository, runtime);
                let lock = clones.get(clone);
                if (lock === undefined)
                  clones.set(clone, (lock = Semaphore.makeUnsafe(1)));
                const started = Date.now();
                // A preparation holds a slot as a query does, in its askers' class.
                const prepared = yield* lock.withPermits(1)(
                  withSlot(() => [...asked].some((waiting) => waiting()))(
                    cpuWork(
                      "graph.prepare",
                      Effect.gen(function* () {
                        const managed = yield* Effect.serviceOption(CpuWork);
                        yield* git(clone, [
                          "update-ref",
                          "--no-deref",
                          "HEAD",
                          commit,
                        ]);
                        return yield* prepareGraphSnapshot(
                          {
                            executable: runtime.executable,
                            repository: clone,
                            revision: commit,
                          },
                          // No queue class or deadline: a preparation asks at the service's default
                          // (background) class, and its own deadline is the one below.
                          {
                            ...(Option.isSome(managed)
                              ? { cpuThreads: 1 }
                              : {}),
                            cacheDirectory: cacheDirectory(runtime),
                            temporaryParent: temporaryParent(runtime),
                            niceness: GRAPH_POLITE.niceness,
                            onCommandUsage: (command) =>
                              addUsage(usage, command),
                          },
                        );
                      }),
                    ).pipe(
                      // Interrupting graph-client's command aborts it, which kills the engine.
                      Effect.timeoutOrElse({
                        duration: GRAPH_PREPARE_DEADLINE_MS,
                        orElse: () =>
                          Effect.fail(
                            new GraphUnavailable(
                              `Graph did not prepare the base within ${GRAPH_PREPARE_DEADLINE_MS / 1000} s`,
                            ),
                          ),
                      }),
                    ),
                  ),
                );
                if (prepared.provider.executable.sha256 !== engineSha256)
                  return yield* Effect.fail(
                    new GraphUnavailable(
                      `the Graph engine at ${runtime.executable} is ${prepared.provider.executable.sha256.slice(0, 12)}, not the ${engineSha256.slice(0, 12)} this run is keyed on`,
                    ),
                  );
                observeService(prepared.service?.answered ?? false);
                // Its CPU is the service's child's when the service ran it, as for a search.
                const attributes = {
                  ...usageAttributes(usage, prepared.service),
                  ...serviceAttributes(prepared.service),
                };
                yield* Effect.annotateCurrentSpan(attributes);
                return {
                  clone,
                  millis: Date.now() - started,
                  cache: prepared.cache.status,
                  files: prepared.counts.files,
                  store: prepared.store,
                  attributes,
                };
              }).pipe(
                Effect.provideService(
                  Worker.HeavyWork,
                  Worker.HeavyWork.defaultValue(),
                ),
                Effect.withSpan("harness.graph.prepare", {
                  attributes: { "harness.commit": commit },
                }),
                Effect.provide(environment),
              ),
            ).then((exit) => {
              if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
              return exit.value;
            });
            held.catch(() => preparations.delete(key));
            preparing++;
            void held.then(
              () => preparing--,
              () => preparing--,
            );
            preparations.set(key, held);
          }
          const settled = () => {
            asked.delete(urgent);
            if (asked.size === 0 && preparationAskers.get(key) === asked)
              preparationAskers.delete(key);
          };
          return held.then(
            (prepared) => {
              settled();
              return { ...prepared, made };
            },
            (error: unknown) => {
              settled();
              throw error;
            },
          );
        },
        catch: (cause) =>
          cause instanceof KeyHeld
            ? cause
            : new GraphUnavailable(
                `Graph could not prepare the base snapshot: ${String((cause as { message?: unknown }).message ?? cause).slice(0, 300)}`,
              ),
      }),
    );
  });

/** The bounded Graph store's account of its cache, as span attributes (`harness.graph.store.*`). */
const storeAttributes = (store: GraphStoreUsage | undefined) =>
  store === undefined
    ? {}
    : {
        "harness.graph.store.bytes": store.bytes,
        "harness.graph.store.cap_bytes": store.capBytes,
        "harness.graph.store.min_free_bytes": store.minFreeBytes,
        ...(store.freeBytes === undefined
          ? {}
          : { "harness.graph.store.free_bytes": store.freeBytes }),
        "harness.graph.store.declared_bytes": store.declaredBytes,
        "harness.graph.store.pinned_bytes": store.pinnedBytes,
        "harness.graph.store.evicted_bytes": store.evictedBytes,
        "harness.graph.store.evicted_entries": store.evictedEntries,
        ...Object.fromEntries(
          Object.entries(store.families).map(([family, bytes]) => [
            `harness.graph.store.family.${family}`,
            bytes,
          ]),
        ),
      };

/** What one search's Graph commands used, summed as each one ends (graph-client's usage). */
interface GraphUsage {
  commands: number;
  wallMs: number;
  userMs: number;
  systemMs: number;
  cpuUnreported: number;
}

const addUsage = (usage: GraphUsage, command: GraphCommandUsage) => {
  usage.commands++;
  usage.wallMs += command.wallMs;
  if (command.cpu === null) usage.cpuUnreported++;
  else {
    usage.userMs += command.cpu.userMs;
    usage.systemMs += command.cpu.systemMs;
  }
};

const milliseconds = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The search's CPU in milliseconds: the shared Graph service's for it, with its `git` children,
 * when the service answered it (the command that forwarded it to the service uses next to none);
 * otherwise the commands this process ran, with their children.
 */
const searchCpu = (
  usage: GraphUsage,
  service: GraphServiceStats | undefined,
) =>
  service?.answered === true &&
  service.cpuUserMs !== undefined &&
  service.cpuSystemMs !== undefined
    ? { userMs: service.cpuUserMs, systemMs: service.cpuSystemMs }
    : { userMs: usage.userMs, systemMs: usage.systemMs };

/**
 * The search span's attributes for what it used: its CPU (`searchCpu`, marked estimated when the
 * service shared one engine run among reads), and what the commands this process ran used, apart,
 * when the service did the work.
 */
const usageAttributes = (
  usage: GraphUsage,
  service: GraphServiceStats | undefined,
) => {
  const cpu = searchCpu(usage, service);
  const delegated =
    cpu.userMs !== usage.userMs || cpu.systemMs !== usage.systemMs;
  return {
    "harness.graph.commands": usage.commands,
    "harness.graph.wall_ms": milliseconds(usage.wallMs),
    "harness.graph.cpu.user_ms": milliseconds(cpu.userMs),
    "harness.graph.cpu.system_ms": milliseconds(cpu.systemMs),
    // The service's share of an engine run that served several reads at once, not a measure.
    ...(delegated && service?.cpuShared === true
      ? { "harness.graph.cpu.estimated": true }
      : {}),
    ...(delegated
      ? {
          "harness.graph.client.cpu.user_ms": milliseconds(usage.userMs),
          "harness.graph.client.cpu.system_ms": milliseconds(usage.systemMs),
        }
      : {}),
    ...(usage.cpuUnreported === 0
      ? {}
      : { "harness.graph.cpu.unreported_commands": usage.cpuUnreported }),
  };
};

/** The shared Graph service's block (graph-client's `service`), as span attributes. */
const serviceAttributes = (service: GraphServiceStats | undefined) =>
  service === undefined
    ? {}
    : {
        "harness.graph.service.answered": service.answered,
        ...Object.fromEntries(
          Object.entries(service)
            .filter(([field]) => field !== "answered")
            .map(([field, value]) => [
              `harness.graph.service.${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              value,
            ]),
        ),
      };

/** Graph's own account of the search (graph-client's `stats` and `cache`), as span attributes. */
const statsAttributes = (observation: GraphQueryObservation) => ({
  ...Object.fromEntries(
    Object.entries(observation.stats).map(([field, value]) => [
      `harness.graph.${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      value,
    ]),
  ),
  "harness.graph.index_cache": observation.cache.status,
  ...(observation.cache.indexLatencyMs === null
    ? {}
    : { "harness.graph.index_latency_ms": observation.cache.indexLatencyMs }),
  ...serviceAttributes(observation.service),
});

/**
 * A search's place in the shared Graph service's queue, read when its engine call starts: the
 * interactive class with the waiting callers' deadline while one waits on it (a review), else the
 * background class with none (commit preparation, background leads, a search its callers left).
 */
interface SearchQueue {
  readonly class: "interactive" | "background";
  readonly deadlineMs?: number;
}

/**
 * One semantic query; the observation, or the reason it has none. Interrupting it (the search's
 * deadline) aborts graph-client's command, which kills the engine, and waits for the engine to
 * have exited, so the query slot is never free while a killed engine still runs and the search's
 * CPU is complete.
 */
const inspect = (
  clone: string,
  commit: string,
  question: string,
  config: GraphConfig,
  runtime: GraphRuntime,
  usage: GraphUsage,
  queue: SearchQueue,
) =>
  Effect.flatMap(Effect.serviceOption(CpuWork), (managed) =>
    Effect.uninterruptibleMask((restore) => {
      const controller = new AbortController();
      const running = (async () => {
        let observation: GraphQueryObservation | undefined;
        let engine: string | undefined;
        let failure: string | undefined;
        let deadline = false;
        await runGraphInspection(
          {
            executable: runtime.executable,
            repository: clone,
            revision: commit,
            question,
            limits: {
              topK: config.topK,
              maxContextBytes: GRAPH_LIMITS.maxContextBytes,
            },
            relationships: [],
            cache: "prepared",
            profile: config.profile,
          },
          {
            ...(Option.isSome(managed) ? { cpuThreads: 1 } : {}),
            cacheDirectory: cacheDirectory(runtime),
            temporaryParent: temporaryParent(runtime),
            niceness: GRAPH_POLITE.niceness,
            signal: controller.signal,
            // Many searches per process: the engine's hash, version and capabilities once per build.
            reuseIdentity: true,
            serviceClass: queue.class,
            ...(queue.deadlineMs === undefined
              ? {}
              : { serviceDeadlineMs: queue.deadlineMs }),
            onCommandUsage: (command) => addUsage(usage, command),
            emit: async (event) => {
              engine = event.identity.provider.executable.sha256;
              if (event.kind !== "retrieval") return;
              if (event.outcome.kind === "success")
                observation = event.outcome.value;
              else {
                failure = event.outcome.error.message;
                deadline = event.outcome.error.serviceDeadline === true;
              }
            },
          },
        );
        // The service stopped waiting for its callers here but carries on and keeps the answer.
        if (deadline)
          throw new GraphPending(
            "Graph's service is still working on this search past its callers' wait; it keeps the answer, so asking again later returns it",
          );
        // An answer from another engine build never lands under this run's engine key.
        if (observation !== undefined && engine !== config.engine.sha256)
          throw new GraphUnavailable(
            `the Graph engine at ${runtime.executable} is ${(engine ?? "unreported").slice(0, 12)}, not the ${config.engine.sha256.slice(0, 12)} this run is keyed on`,
          );
        if (observation === undefined)
          throw new GraphUnavailable(
            `Graph gave no answer: ${failure ?? "no retrieval event"}`,
          );
        return observation;
      })();
      // Started and guarded with interruption masked, so no interruption can fall between the two.
      return restore(
        Effect.tryPromise({
          try: () => running,
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
      ).pipe(
        Effect.onInterrupt(() => {
          controller.abort();
          return Effect.promise(() =>
            running.then(
              () => undefined,
              () => undefined,
            ),
          );
        }),
      );
    }),
  );

/** The chunk on the same path that shares most lines with [start, end], for metadata. */
const bestChunk = (
  index: TreeIndex,
  path: string,
  start: number,
  end: number,
) => {
  let best: { chunk: IndexedChunk; shared: number } | undefined;
  for (const doc of index.byPath.get(path) ?? []) {
    const chunk = index.chunks[doc];
    if (chunk === undefined) continue;
    const shared =
      Math.min(end, chunk.endLine) - Math.max(start, chunk.startLine) + 1;
    if (shared > 0 && (best === undefined || shared > best.shared))
      best = { chunk, shared };
  }
  return best?.chunk;
};

/**
 * Graph's results as the port's search results at the base tree: the region Graph returned, with
 * the 10.45 metadata of the shared chunk it overlaps most, and the callables Graph names inside it.
 * Graph ranks without a score, so `score` is 1 ÷ rank. A region outside the base tree is dropped
 * and counted.
 */
export const graphResults = (
  repository: string,
  index: TreeIndex,
  observation: GraphQueryObservation,
  querySha256: string,
) =>
  Effect.gen(function* () {
    const entries = new Map(
      (yield* lsTree(repository, index.tree)).map((entry) => [
        entry.path,
        entry,
      ]),
    );
    const blobs = [
      ...new Set(
        observation.results.flatMap(
          (result) => entries.get(result.source.path)?.oid ?? [],
        ),
      ),
    ];
    const texts = yield* readBlobs(repository, blobs);
    const results: Array<SearchResult> = [];
    let dropped = 0;
    let unreadable = 0;
    for (const result of observation.results) {
      const { path, startLine } = result.source;
      const entry = entries.get(path);
      const bytes = entry === undefined ? undefined : texts.get(entry.oid);
      if (entry === undefined || bytes === undefined) {
        dropped++;
        if (entry !== undefined) unreadable++;
        continue;
      }
      const lines = splitLines(new TextDecoder().decode(bytes));
      const endLine = Math.min(result.source.endLine, lines.length);
      if (startLine > endLine) {
        dropped++;
        continue;
      }
      const text = lines.slice(startLine - 1, endLine).join("");
      const chunk = bestChunk(index, path, startLine, endLine);
      const callables =
        result.containedCallables.kind === "unavailable"
          ? (chunk?.callables ?? [])
          : result.containedCallables.items.map((item) => item.symbol);
      const symbol =
        result.kind === "symbol"
          ? result.symbol
          : "symbol" in result && typeof result.symbol === "string"
            ? result.symbol
            : null;
      const rank = results.length + 1;
      results.push({
        identity: {
          tree: index.tree,
          blobOid: entry.oid,
          path,
          startLine,
          endLine,
          chunkId: chunkIdOf(entry.oid, startLine, endLine),
          recipe: CHUNK_RECIPE,
        },
        kind:
          chunk === undefined || chunk.declared === "undeclared"
            ? "undeclared"
            : [...chunk.declared],
        language: chunk?.language ?? result.language ?? "undeclared",
        capability: chunk?.capability ?? WINDOW_RECIPE,
        enclosing: {
          kind: symbol !== null ? "symbol" : (chunk?.kind ?? "window"),
          name: symbol ?? chunk?.symbol ?? null,
          headingPath: [...(chunk?.headingPath ?? [])],
        },
        callables: [...new Set(callables)].slice(0, 32),
        identifiers: {
          specific:
            chunk === undefined
              ? []
              : specificIdentifiers(index, chunkIdentifiers(chunk, text)),
          from:
            chunk === undefined || chunk.parsedIdentifiers === null
              ? "word-tokens"
              : "code-positions",
        },
        neighbours: {
          previous: chunk?.previous ?? null,
          next: chunk?.next ?? null,
          outline: `${path}@${index.tree}`,
        },
        retrieval: {
          retriever: "graph",
          querySha256,
          rank,
          score: Number((1 / rank).toPrecision(9)),
          tokens: estimateTokens(Buffer.byteLength(text)),
        },
        coverage: { vectors: "not-applicable", stale: false },
      });
    }
    return { results, dropped, unreadable };
  });

/** The span of one Graph search's own work: its preparation wait, slot wait and engine run. */
export const GRAPH_SEARCH_SPAN = "harness.graph.search";

/**
 * How long the engine may run one search once it holds the slot; past it the engine is stopped.
 * The waits for the base (`GRAPH_PREPARE_DEADLINE_MS` bounds its preparation) and for the slot are
 * not counted, so a search queued behind others is never cut off before it runs. Its callers wait
 * less (each retriever's `waitMs`) and leave it running, so an answer nobody waited for is still
 * kept (architecture record 0013).
 */
export const GRAPH_SEARCH_DEADLINE_MS = 120_000;

/**
 * The bound on one engine call: `GRAPH_SEARCH_DEADLINE_MS`, or past a longer service deadline (a
 * review's wait may be longer), so the service's own deadline, which keeps the search running,
 * always ends the call first.
 */
const runBound = (queue: SearchQueue) =>
  Math.max(GRAPH_SEARCH_DEADLINE_MS, (queue.deadlineMs ?? 0) + 10_000);

/** A caller's wait for Graph's whole answer, however long the queue: background work only. */
export const GRAPH_WHOLE_ANSWER = Number.POSITIVE_INFINITY;

/** A Graph search still running when its caller stopped waiting: it keeps running and keeps its answer. */
export class GraphPending extends Error {
  readonly _tag = "GraphPending";
}

/**
 * Searches running in this process, by key, shared by every caller that asks the same one, with how
 * many of their callers are waiting for them now within a bounded wait (the slot's urgent class).
 */
const running = new Map<
  string,
  {
    readonly deferred: Deferred.Deferred<GraphQueryObservation, unknown>;
    /** When each caller still waiting on it, within a bounded wait, stops waiting (epoch ms). */
    readonly waiters: Set<{ readonly until: number }>;
  }
>();
/**
 * Graph work running in this process: searches and base preparations. A worker never idles out
 * while any runs (its `detachedWork`), so a search a review stopped waiting for finishes and keeps
 * its answer, and a prepared base is not lost mid-way.
 */
export const graphSearchesInFlight = Effect.sync(
  () => running.size + preparing,
);

/** Answers of the last searches, by key, for a caller that asks again after it stopped waiting. */
const answered = new Map<string, GraphQueryObservation>();
const ANSWERED = 64;

const remember = (key: string, observation: GraphQueryObservation) => {
  answered.delete(key);
  answered.set(key, observation);
  while (answered.size > ANSWERED) {
    const oldest = answered.keys().next().value;
    if (oldest === undefined) break;
    answered.delete(oldest);
  }
};

/**
 * One Graph search's own work, in its own span (`GRAPH_SEARCH_SPAN`): the base's preparation, the
 * query slot in `urgent`'s class and the engine, bounded by `GRAPH_SEARCH_DEADLINE_MS` once it
 * runs, with Graph's timings, the engine's CPU and the two waits recorded on it however it ends.
 */
const searchWork = (
  repository: string,
  commit: string,
  question: string,
  config: GraphConfig,
  runtime: GraphRuntime,
  urgent: () => boolean,
  queueOf: () => SearchQueue,
) =>
  Effect.gen(function* () {
    const now = yield* spanClock;
    const begun = now();
    const usage: GraphUsage = {
      commands: 0,
      wallMs: 0,
      userMs: 0,
      systemMs: 0,
      cpuUnreported: 0,
    };
    const span = Option.getOrUndefined(
      yield* Effect.option(Effect.currentSpan),
    );
    const work = Effect.gen(function* () {
      const { clone, store, made, attributes } = yield* prepareBase(
        repository,
        commit,
        runtime,
        config.engine.sha256,
        // The base is waited on exactly while this search is.
        urgent,
      );
      // The store as the base's preparation measured it (the preparation's own span runs detached
      // and is not kept).
      yield* Effect.annotateCurrentSpan(storeAttributes(store));
      const ready = now();
      // What the preparation used, with the service's block for it (lane `prepare`), on the one
      // search that started it, so it is kept and counted once.
      span?.event(GRAPH_EVENTS.baseReady, ready, made ? attributes : undefined);
      return yield* withSlot(urgent)(
        Effect.suspend(() => {
          const taken = now();
          span?.event(GRAPH_EVENTS.slotTaken, taken, {
            "harness.graph.slot_wait_ms": milliseconds(
              secondsBetween(ready, taken) * 1000,
            ),
            // Whether a caller was still waiting on it when it ran, or only background work.
            "harness.graph.waited_on": urgent(),
          });
          const queue = queueOf();
          span?.attribute("harness.graph.queue.class", queue.class);
          if (queue.deadlineMs !== undefined)
            span?.attribute(
              "harness.graph.queue.deadline_ms",
              queue.deadlineMs,
            );
          // The run's own bound stays for a call the engine runs in its own process (service off,
          // unavailable or mismatched), which no service deadline reaches.
          return cpuWork(
            "graph.search",
            inspect(clone, commit, question, config, runtime, usage, queue),
          ).pipe(
            Effect.timeoutOrElse({
              duration: runBound(queue),
              orElse: () =>
                Effect.fail(
                  new GraphUnavailable(
                    `Graph did not answer within ${Math.round(runBound(queue) / 1000)} s of running`,
                  ),
                ),
            }),
          );
        }),
      );
    });
    // Counted in and out as one acquire and release, so no interruption leaves the count off.
    const tracked = Effect.acquireUseRelease(
      Effect.sync(() => {
        if (busy.searches++ === 0) busy.since = now();
      }),
      () => work,
      () =>
        --busy.searches === 0
          ? recordLate(
              Metric.update(
                METRICS.graphBusy,
                secondsBetween(busy.since, now()),
              ),
            )
          : Effect.void,
    );
    const observation = yield* tracked.pipe(
      // Also when the search fails or reaches its deadline, which is when its CPU matters most.
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const service = Exit.isSuccess(exit) ? exit.value.service : undefined;
          yield* Effect.annotateCurrentSpan(usageAttributes(usage, service));
          const cpu = searchCpu(usage, service);
          // A search the service carries on after its callers' deadline is not a gap in Graph.
          const deadline =
            Exit.isFailure(exit) &&
            Cause.findErrorOption(exit.cause).pipe(
              Option.exists((error) => error instanceof GraphPending),
            );
          if (deadline)
            yield* Effect.annotateCurrentSpan({
              "harness.graph.service.deadline": true,
            });
          // How many calls the service runs at once, as this call found it. A search the service
          // is still working on says it is up; any other failure counts as no service, so engines
          // never stay doubled up in this process after it goes away.
          if (Exit.isSuccess(exit)) observeService(service?.answered ?? false);
          else if (!deadline) observeService(false);
          const status = {
            "harness.status": Exit.isSuccess(exit)
              ? "answered"
              : deadline
                ? "deadline"
                : "gap",
          };
          // Recorded even when its review's attempt has ended before it (`recordLate`).
          yield* recordLate(
            Effect.andThen(
              Metric.update(
                Metric.withAttributes(METRICS.graphSearch, status),
                secondsBetween(begun, now()),
              ),
              Metric.update(
                Metric.withAttributes(METRICS.graphSearchCpu, status),
                (cpu.userMs + cpu.systemMs) / 1_000,
              ),
            ),
          );
        }),
      ),
    );
    yield* Effect.annotateCurrentSpan(statsAttributes(observation));
    return observation;
  }).pipe(
    Effect.withSpan(GRAPH_SEARCH_SPAN, {
      attributes: { "harness.commit": commit },
    }),
  );

/**
 * The search's observation for a caller who waits at most `waitMs`: an answer already kept
 * (`ready`), the same search another caller started (`joined`), or a new one (`computed`). The
 * search runs detached from its callers, so a caller that stops waiting fails with GraphPending and
 * the search finishes and keeps its answer for the next ask. Each caller's span records how it got
 * its answer (`harness.graph.answer`).
 */
const searchOnce = (
  repository: string,
  commit: string,
  question: string,
  config: GraphConfig,
  runtime: GraphRuntime,
  waitMs: number,
) =>
  Effect.flatMap(Worker.HeavyWork, (gate) =>
    gate.start(
      Effect.gen(function* () {
        const key = [
          repository,
          commit,
          runtime.workDirectory,
          config.engine.sha256,
          config.profile,
          config.topK,
          question,
        ].join("\0");
        const kept = answered.get(key);
        if (kept !== undefined) {
          remember(key, kept);
          yield* Effect.annotateCurrentSpan({
            "harness.graph.answer": "ready",
          });
          return kept;
        }
        let held = running.get(key);
        const how = held === undefined ? "computed" : "joined";
        if (held === undefined) {
          const entry = {
            deferred: Deferred.makeUnsafe<GraphQueryObservation, unknown>(),
            waiters: new Set<{ readonly until: number }>(),
          };
          held = entry;
          running.set(key, entry);
          yield* Effect.forkDetach(
            searchWork(
              repository,
              commit,
              question,
              config,
              runtime,
              () => entry.waiters.size > 0,
              (): SearchQueue =>
                entry.waiters.size > 0
                  ? {
                      class: "interactive",
                      deadlineMs: Math.max(
                        1,
                        Math.max(
                          ...[...entry.waiters].map((waiter) => waiter.until),
                        ) - Date.now(),
                      ),
                    }
                  : { class: "background" },
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.andThen(
                  Effect.sync(() => {
                    running.delete(key);
                    if (Exit.isSuccess(exit)) remember(key, exit.value);
                  }),
                  Deferred.done(entry.deferred, exit),
                ),
              ),
            ),
          );
        }
        const answer = Deferred.await(held.deferred).pipe(
          Effect.tap(() =>
            Effect.annotateCurrentSpan({ "harness.graph.answer": how }),
          ),
        );
        // A caller that waits for the whole answer (background work) never makes the search urgent.
        if (!Number.isFinite(waitMs)) return yield* answer;
        const entry = held;
        const waiter = { until: Date.now() + waitMs };
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            entry.waiters.add(waiter);
          }),
          () =>
            answer.pipe(
              Effect.timeoutOrElse({
                duration: waitMs,
                orElse: () =>
                  Effect.andThen(
                    Effect.annotateCurrentSpan({
                      "harness.graph.answer": "pending",
                    }),
                    Effect.fail(
                      new GraphPending(
                        `Graph is still working on this search after ${Math.round(waitMs / 1000)} s; it keeps running and keeps its answer, so asking again later returns it`,
                      ),
                    ),
                  ),
              }),
            ),
          () =>
            Effect.sync(() => {
              entry.waiters.delete(waiter);
            }),
        );
      }).pipe(
        Effect.provideService(
          Worker.HeavyWork,
          Worker.HeavyWork.defaultValue(),
        ),
      ),
    ),
  );

/**
 * `searchOnce`, asked again when the search it joined ended at another caller's deadline in the
 * shared service (`GraphPending` from the search itself) while this caller still has time: the
 * service carried on, so the next ask joins or reads its answer.
 */
const sharedSearch = (
  repository: string,
  commit: string,
  question: string,
  config: GraphConfig,
  runtime: GraphRuntime,
  waitMs: number,
) =>
  Effect.gen(function* () {
    const until = Date.now() + waitMs;
    // A few asks at most: each new one carries this caller's own deadline, so it ends at it.
    for (let ask = 1; ; ask++) {
      const left = until - Date.now();
      const exit = yield* Effect.exit(
        searchOnce(repository, commit, question, config, runtime, left),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      const pending = Cause.findErrorOption(exit.cause).pipe(
        Option.exists((error) => error instanceof GraphPending),
      );
      if (!pending || until - Date.now() <= 0 || ask === 3) return yield* exit;
    }
  });

/**
 * Graph over the base commit. A caller waits at most `waitMs` for an answer, the wait for the
 * base's preparation and a query slot included (`GRAPH_WHOLE_ANSWER` for background work, which
 * waits for it in full); past it the search fails with GraphPending (it keeps running,
 * `sharedSearch`), and a search that fails fails with GraphUnavailable. Callers
 * disclose either as a gap or a fallback. The answer reports Graph's own coverage note and what it
 * dropped.
 */
export const graphRetriever = (
  repository: string,
  index: TreeIndex,
  commit: string,
  config: GraphConfig,
  runtime: GraphRuntime,
  waitMs: number,
): Retriever => ({
  description: {
    id: "graph",
    family: "graph",
    config,
    index: indexRecipe(index.source),
  },
  tree: index.tree,
  search: (query) =>
    Effect.gen(function* () {
      const started = Date.now();
      const observation = yield* sharedSearch(
        repository,
        commit,
        query.text,
        config,
        runtime,
        waitMs,
      );
      const { results, dropped, unreadable } = yield* graphResults(
        repository,
        index,
        observation,
        query.sha256,
      );
      const gaps: Array<string> = [];
      if (dropped > unreadable)
        gaps.push(
          `${dropped - unreadable} Graph result(s) were not in the base tree`,
        );
      if (unreadable > 0)
        gaps.push(
          `${unreadable} Graph result(s) are in the base tree, but their text could not be read`,
        );
      if (observation.budget.resultsDroppedByBudget > 0)
        gaps.push(
          `Graph dropped ${observation.budget.resultsDroppedByBudget} result(s) by its context budget`,
        );
      // Kinds only reorder (10.45); the rank is the position shown, the score Graph's own order.
      const ordered = reorderByKind(results, query.kinds)
        .slice(0, query.limit)
        .map((result, position) => ({
          ...result,
          retrieval: { ...result.retrieval, rank: position + 1 },
        }));
      return {
        results: ordered,
        millis: Date.now() - started,
        coverage: {
          chunks: observation.indexedFileCount ?? 0,
          excluded: {},
        },
        gaps,
        graphCoverage: observation.coverage,
      } satisfies RetrievalAnswer & { graphCoverage: string };
    }).pipe(
      Effect.withSpan("harness.retriever.search", {
        attributes: { "harness.retriever": "graph", "harness.commit": commit },
      }),
    ),
});
