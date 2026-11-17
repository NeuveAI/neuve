import {
  captureOutlineSource,
  outlineExecutable,
} from "../src/graph-outline.ts";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
// Guard admission, sharing and review-yield boundaries with real chunk computations and Records.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { Effect, Layer, Logger } from "effect";
import { CpuWork, cpuPool } from "../src/budget/cpu.ts";
import {
  Scheduler,
  type Budget,
  type Priority,
} from "../src/budget/scheduler.ts";
import { hostBudget, localBudget } from "../src/budget/local.ts";
import { CodeWork, IndexLease, withCodeWork } from "../src/code-work.ts";
import { blobChunks } from "../src/search-index.ts";

const root = mkdtempSync(join(tmpdir(), "index-budget-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const preparation: Priority = {
  class: "preparation",
  position: "new",
  stage: 0,
};
const interactive: Priority = {
  class: "interactive",
  position: "understand",
  stage: 0,
};
const layerFor = (directory: string) => {
  const location = storeLocationIn(directory);
  return Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
};
const input = (name: string, count = 260) => {
  const contents = new Map<string, Uint8Array>();
  const entries = Array.from({ length: count }, (_, n) => {
    const bytes = new TextEncoder().encode(
      `export const ${name}${n} = ${n};\n`,
    );
    const oid = createHash("sha1").update(bytes).digest("hex");
    contents.set(oid, bytes);
    return {
      mode: "100644",
      type: "blob",
      oid,
      size: bytes.length,
      path: `${name}${n}.ts`,
    };
  });
  return { entries, contents };
};
const chunks = (name: string, count?: number) => {
  const { entries, contents } = input(name, count);
  return blobChunks(root, entries, captureOutlineSource(), contents);
};
const admitted = <A, E, R>(
  budget: Budget,
  priority: Priority,
  work: Effect.Effect<A, E, R>,
) =>
  work.pipe(
    Effect.provideService(CpuWork, { budget, priority, inherited: false }),
  );

test("concurrent cold preparations share computations and stay within one CPU permit", async () => {
  const budget = new Scheduler(1);
  const admit = budget.admit.bind(budget);
  let peak = 0;
  let admissions = 0;
  budget.admit = async (...args) => {
    const grant = await admit(...args);
    admissions++;
    peak = Math.max(peak, (await budget.observe()).held ?? 0);
    return grant;
  };
  const results = await Effect.runPromise(
    Effect.all(
      [
        admitted(budget, preparation, chunks("shared")),
        admitted(budget, preparation, chunks("shared")),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(layerFor(join(root, "shared")))),
  );
  expect(results.map((result) => result.chunks.size)).toEqual([260, 260]);
  expect(results.reduce((n, result) => n + result.computed, 0)).toBe(260);
  expect([...results[0].chunks]).toEqual([...results[1].chunks]);
  expect(peak).toBe(1);
  expect(admissions).toBeGreaterThanOrEqual(6);
  expect(admissions).toBeLessThan(520);
  expect((await budget.observe()).held).toBe(0);
}, 15000);

test("independent preparation clients share the host's CPU limit over real sockets", async () => {
  const directory = join(root, "socket-budget");
  const host = await hostBudget({ directory, threads: 1, efficiency: 1 });
  if (!host) throw new Error("Test budget host did not start");
  const admit = host.scheduler.admit.bind(host.scheduler);
  let peak = 0;
  let admissions = 0;
  host.scheduler.admit = async (...args) => {
    const grant = await admit(...args);
    admissions++;
    peak = Math.max(peak, (await host.scheduler.observe()).held ?? 0);
    return grant;
  };
  try {
    const results = await Effect.runPromise(
      Effect.all(
        [
          admitted(localBudget(directory), preparation, chunks("socketFirst")),
          admitted(localBudget(directory), preparation, chunks("socketSecond")),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(layerFor(join(root, "socket-store")))),
    );
    expect(results.map((result) => result.computed)).toEqual([260, 260]);
    expect(peak).toBe(1);
    expect(admissions).toBeGreaterThanOrEqual(6);
    expect(admissions).toBeLessThan(520);
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    await host.close();
  }
}, 15000);

// These two cases time real chunk computations, which read declarations from the built Graph
// engine; without it they measure nothing (`bun run build:graph`).
const graphPrerequisite = graphTestPrerequisite({
  available: existsSync(outlineExecutable()),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

for (const holdBackground of [false, true])
  test.skipIf(graphPrerequisite.skip)(
    holdBackground
      ? "a foreground second admission overlaps a held background batch within the fairness bound"
      : "a foreground preparation overtakes a background build at its next batch release",
    async () => {
      graphPrerequisite.require();
      const budget = new Scheduler(1);
      const started = Promise.withResolvers<void>();
      const queued = Promise.withResolvers<void>();
      const classes: string[] = [];
      type Admission = { id: number; priority: Priority["class"] };
      const waiting = new Map<number, Admission>();
      const active = new Map<number, Admission>();
      type AdmissionEvent = {
        kind: "queued" | "granted" | "released" | "rejected";
        request: Admission;
        queue: Admission[];
        active: Admission[];
        previousCpuGrant: Priority["class"] | null;
      };
      const events: AdmissionEvent[] = [];
      let previousCpuGrant: Priority["class"] | null = null;
      const record = (kind: AdmissionEvent["kind"], request: Admission) => {
        events.push({
          kind,
          request,
          queue: [...waiting.values()],
          active: [...active.values()],
          previousCpuGrant,
        });
      };
      let nextRequest = 0;
      let foregroundRequests = 0;
      let backgroundRequests = 0;
      const backgroundGranted = Promise.withResolvers<void>();
      const foregroundSecondQueued = Promise.withResolvers<void>();
      const until = (gate: Promise<void>, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          const done = () => {
            signal?.removeEventListener("abort", done);
            resolve();
          };
          signal?.addEventListener("abort", done, { once: true });
          gate.then(done);
          if (signal?.aborted) done();
        });
      let secondForeground: number | undefined;
      const contenderAbort = new AbortController();
      let contender: Promise<void> | undefined;
      const admit = budget.admit.bind(budget);
      budget.admit = async (request, signal) => {
        const entry = { id: nextRequest++, priority: request.priority.class };
        waiting.set(entry.id, entry);
        record("queued", entry);
        const foregroundNumber =
          entry.priority === "interactive" ? ++foregroundRequests : 0;
        if (foregroundNumber) {
          if (foregroundNumber === 2) secondForeground = entry.id;
          queued.resolve();
        }
        const backgroundNumber =
          entry.priority === "preparation" &&
          request.owner !== "priority-contender"
            ? ++backgroundRequests
            : 0;
        try {
          const pending = admit(request, signal);
          if (foregroundNumber === 2) foregroundSecondQueued.resolve();
          const grant = await pending;
          active.set(entry.id, entry);
          record("granted", entry);
          previousCpuGrant = entry.priority;
          waiting.delete(entry.id);
          classes.push(entry.priority);
          if (foregroundNumber === 1) contenderAbort.abort();
          if (classes.length === 1) {
            started.resolve();
            await until(queued.promise, signal);
            // Make the first interactive grant genuinely contended, then cancel the unused rival.
            if (!signal?.aborted)
              contender = budget
                .admit(
                  {
                    owner: "priority-contender",
                    priority: preparation,
                    resource: { kind: "cpu", permits: 1 },
                  },
                  contenderAbort.signal,
                )
                .then((rival) => rival.release())
                .catch((error) => {
                  if (!contenderAbort.signal.aborted) throw error;
                });
          }
          if (holdBackground && backgroundNumber === 2) {
            backgroundGranted.resolve();
            await until(foregroundSecondQueued.promise, signal);
          }
          return {
            ...grant,
            release(observation) {
              const result = grant.release(observation);
              active.delete(entry.id);
              record("released", entry);
              return result;
            },
          };
        } catch (error) {
          waiting.delete(entry.id);
          record("rejected", entry);
          throw error;
        }
      };
      const foreground = Effect.gen(function* () {
        const work = chunks(
          holdBackground ? "foregroundHeld" : "foreground",
          1,
        );
        if (!holdBackground) return yield* work;
        const store = yield* Computations.ComputationStore;
        return yield* work.pipe(
          Effect.provideService(Computations.ComputationStore, {
            ...store,
            // Wait after the outline read, outside admission, until the background owns the next grant.
            run: (spec, compute) =>
              Effect.andThen(
                Effect.promise((signal) =>
                  until(backgroundGranted.promise, signal),
                ),
                store.run(spec, compute),
              ),
          }),
        );
      });
      const results = await (async () => {
        try {
          return await Effect.runPromise(
            Effect.all(
              [
                admitted(
                  budget,
                  preparation,
                  chunks(holdBackground ? "backgroundHeld" : "background"),
                ),
                admitted(
                  budget,
                  interactive,
                  Effect.andThen(
                    Effect.promise(() => started.promise),
                    foreground,
                  ),
                ),
              ],
              { concurrency: 2 },
            ).pipe(
              Effect.provide(
                layerFor(
                  join(root, holdBackground ? "foreground-held" : "foreground"),
                ),
              ),
            ),
          );
        } finally {
          contenderAbort.abort();
          queued.resolve();
          backgroundGranted.resolve();
          foregroundSecondQueued.resolve();
          await contender;
        }
      })();
      expect(results.map((result) => result.computed)).toEqual([260, 1]);
      // drain's exception is `this.threads === 1 && !this.lastCpuBackground && bgNext`.
      // The flag starts false; CPU grant sets `this.lastCpuBackground = bg`, with
      // `bg = w.request.priority.class !== "interactive"`. A preparation grant sets it true,
      // so another preparation cannot overtake a pending interactive request immediately afterward.
      // On one thread reserve=0 and backgroundCap=1: one active preparation OR one fairness turn
      // without an active preparation, never both. The tight total is max(1, 1), not their sum.
      const maxActivePreparation = 1;
      const maxFairnessTurnsWithoutActivePreparation = 1;
      const N_total = Math.max(
        maxActivePreparation,
        maxFairnessTurnsWithoutActivePreparation,
      );
      expect(classes[1]).toBe("interactive");
      const contested = events.filter(
        (event) =>
          event.kind === "granted" &&
          event.queue.some((entry) => entry.priority === "interactive") &&
          event.queue.some((entry) => entry.priority === "preparation"),
      );
      const secondQueued = events.findIndex(
        (event) =>
          event.kind === "queued" && event.request.id === secondForeground,
      );
      const secondGranted = events.findIndex(
        (event) =>
          event.kind === "granted" && event.request.id === secondForeground,
      );
      expect(secondQueued).toBeGreaterThanOrEqual(0);
      expect(secondGranted).toBeGreaterThan(secondQueued);
      const preparationActiveAtQueue = events
        .slice(secondQueued, secondQueued + 1)
        .flatMap((event) =>
          event.active.filter((entry) => entry.priority === "preparation"),
        );
      const preparationGrantedWhileWaiting = events
        .slice(secondQueued + 1, secondGranted)
        .filter(
          (event) =>
            event.kind === "granted" &&
            event.request.priority === "preparation",
        );
      const preparationBeforeForeground = new Set([
        ...preparationActiveAtQueue.map((entry) => entry.id),
        ...preparationGrantedWhileWaiting.map((event) => event.request.id),
      ]);
      console.log(
        JSON.stringify({
          type: "index-budget.admissions",
          holdBackground,
          N_total,
          events,
          preparationActiveAtQueue: preparationActiveAtQueue.length,
          preparationGrantedWhileWaiting: preparationGrantedWhileWaiting.length,
          preparationBeforeForeground: preparationBeforeForeground.size,
        }),
      );
      expect(contested.length).toBeGreaterThan(0);
      if (holdBackground)
        expect(preparationBeforeForeground.size).toBeGreaterThanOrEqual(1);
      expect(preparationBeforeForeground.size).toBeLessThanOrEqual(N_total);
      expect(
        contested.filter(
          (event) =>
            event.request.priority !== "interactive" &&
            !(
              budget.threads === 1 &&
              (event.previousCpuGrant === null ||
                event.previousCpuGrant === "interactive")
            ),
        ),
      ).toEqual([]);
      expect((await budget.observe()).held).toBe(0);
    },
    15000,
  );

// A marker arriving during a batch must not make a waiting checkpoint retain the CPU grant.
// The batch that holds the grant when the marker lands gives it back at its end, and the rest of
// its slice may still take one more bounded batch (cpuBatch re-admits them on the next tick, with
// no checkpoint between): so "nothing held" is asserted once the preparation is parked at its
// checkpoint, not at the instant of the first release, which raced that re-admission on a loaded
// two-CPU runner.
for (const lease of [false, true])
  test(`a review marker releases a background batch with IndexLease=${lease}`, async () => {
    const directory = join(root, `marker-${lease}`);
    const location = storeLocationIn(directory);
    const budget = new Scheduler(1);
    const started = Promise.withResolvers<void>();
    const marked = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const yielded = Promise.withResolvers<void>();
    // Without the lease the preparation waits in place at its checkpoint, which it logs.
    const waiting = Promise.withResolvers<void>();
    const parked = lease ? yielded : waiting;
    const admit = budget.admit.bind(budget);
    let admissions = 0;
    budget.admit = async (...args) => {
      const grant = await admit(...args);
      admissions++;
      if (admissions === 1) {
        started.resolve();
        await marked.promise;
      }
      return {
        ...grant,
        release() {
          grant.release();
          released.resolve();
        },
      };
    };
    const results = await Effect.runPromise(
      Effect.all(
        [
          admitted(budget, preparation, chunks(`marker${lease}`)).pipe(
            Effect.provideService(CodeWork, {
              directory: location.directory,
              background: true,
            }),
            Effect.provideService(IndexLease, lease),
            Effect.result,
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result._tag === "Failure") yielded.resolve();
              }),
            ),
          ),
          Effect.andThen(
            Effect.promise(() => started.promise),
            withCodeWork(
              location,
              false,
              Effect.gen(function* () {
                marked.resolve();
                yield* Effect.promise(() => released.promise);
                // The review is admitted while the preparation is unfinished: a checkpoint that
                // kept the one permit would leave this waiting until the timeout.
                const grant = yield* Effect.promise((signal) =>
                  budget.admit(
                    {
                      owner: "review",
                      priority: interactive,
                      resource: { kind: "cpu", permits: 1 },
                    },
                    signal,
                  ),
                ).pipe(Effect.timeout("5 seconds"));
                yield* Effect.promise(async () => {
                  await grant.release();
                });
                yield* Effect.promise(() => parked.promise);
                expect(
                  (yield* Effect.promise(() => budget.observe())).held,
                ).toBe(0);
              }),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.provide(layerFor(directory)),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              for (const item of [message].flat())
                if (
                  typeof item === "string" &&
                  item.includes("yielding code work to review Precompute")
                )
                  waiting.resolve();
            }),
          ]),
        ),
      ),
    );
    if (lease) {
      expect(results[0]._tag).toBe("Failure");
      if (results[0]._tag === "Failure")
        expect(results[0].failure._tag).toBe("PreparationYielded");
    } else {
      expect(results[0]._tag).toBe("Success");
      if (results[0]._tag === "Success")
        expect(results[0].success.computed).toBe(260);
    }
    expect((await budget.observe()).held).toBe(0);
  }, 15000);

test("an existing outer grant admits once and a warm chunk cache admits nothing", async () => {
  const budget = new Scheduler(1);
  const admit = budget.admit.bind(budget);
  let admissions = 0;
  budget.admit = (...args) => {
    admissions++;
    return admit(...args);
  };
  const result = await Effect.runPromise(
    admitted(
      budget,
      interactive,
      Effect.gen(function* () {
        const cold = yield* cpuPool("outer", 1, () => chunks("outer"));
        const warm = yield* chunks("outer");
        return { cold: cold.computed, reused: warm.reused };
      }),
    ).pipe(Effect.provide(layerFor(join(root, "outer")))),
  );
  expect(result).toEqual({ cold: 260, reused: 260 });
  expect(admissions).toBe(1);
  expect((await budget.observe()).held).toBe(0);
}, 15000);
