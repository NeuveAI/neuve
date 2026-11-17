import { runLogTracer, type RunLogRecord } from "../src/run-log.ts";
// These cases reproduce the integration review's CPU lifetime and recovery failures.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Exit, Option, Tracer } from "effect";
import { CpuWork, cpuPool } from "../src/budget/cpu.ts";
import {
  hostBudget,
  workerBudget,
  closeWorkerBudget,
} from "../src/budget/local.ts";

const root = mkdtempSync(join(tmpdir(), "capacity-recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A test that times out runs its cleanup during the next test, so cleanup touches only its own state.
const restoreBudgetDirectory = (
  directory: string,
  previous: string | undefined,
) => {
  if (process.env.NEUVE_BUDGET_DIRECTORY !== directory) return;
  if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
  else process.env.NEUVE_BUDGET_DIRECTORY = previous;
};
const removeOwnRoots = async (created: ReadonlyArray<string>) => {
  for (const path of created) {
    const index = roots.indexOf(path);
    if (index >= 0) roots.splice(index, 1);
  }
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
};

test("a running in-process pool survives host loss and replays its review on next admission", async () => {
  const directory = join(root, "host-loss");
  const host = await hostBudget({ directory, threads: 4, fixed: 4 });
  if (!host) throw new Error("No host");
  const budget = await workerBudget(directory);
  const deactivate = await budget.activate?.("a".repeat(64), "review");
  let finished = false;
  try {
    const result = await Effect.runPromiseExit(
      cpuPool("precompute.leads", 2, () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => host.close());
          yield* Effect.sleep(20);
          finished = true;
          return "finished";
        }),
      ).pipe(
        Effect.provideService(CpuWork, {
          budget,
          priority: { class: "interactive", position: "understand", stage: 0 },
          inherited: false,
        }),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(finished).toBe(true);
    const next = await budget.admit({
      owner: "next-pool",
      priority: { class: "interactive", position: "understand", stage: 0 },
      resource: { kind: "cpu", permits: 1 },
    });
    expect((await budget.observe()).activeRuns).toBe(1);
    await next.release();
  } finally {
    deactivate?.();
    await host.close();
    await closeWorkerBudget(directory);
  }
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  fakeExecutable,
  fixtureRepository,
  roots,
} from "../../graph-client/tests/graph-client-support.ts";
import { prepareBase } from "../src/graph-search.ts";

test("detached Graph preparation carries its enclosing background pool grant", async () => {
  const directory = join(root, "detached");
  const host = await hostBudget({ directory, threads: 4, fixed: 4 });
  if (!host) throw new Error("No host");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  const records: RunLogRecord[] = [];
  const owners: string[] = [];
  const admit = host.scheduler.admit.bind(host.scheduler);
  host.scheduler.admit = (request, signal) => {
    owners.push(`${request.owner}:${request.priority.class}`);
    return admit(request, signal);
  };
  const created: string[] = [];
  try {
    const fixture = await fixtureRepository();
    created.push(fixture.root);
    const executable = await fakeExecutable("prepared-service-answered");
    created.push(dirname(executable));
    const sha256 = createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex");
    const result = await Effect.runPromise(
      cpuPool("background-graph", 2, () =>
        prepareBase(
          fixture.root,
          fixture.first,
          { executable, workDirectory: join(root, "graph") },
          sha256,
          () => false,
        ),
      ).pipe(
        Effect.provideService(CpuWork, {
          budget: host.scheduler,
          priority: { class: "preparation", position: "new", stage: 0 },
          inherited: false,
        }),
        Effect.withSpan("harness.background-graph"),
        Effect.provideService(
          Tracer.Tracer,
          runLogTracer({
            path: "",
            read: () => records,
            write: (record) => {
              records.push(record);
            },
          }),
        ),
      ),
    );
    const preparations = records.filter(
      (record) =>
        record.type === "span" && record.name === "harness.graph.prepare",
    );
    expect(preparations).toHaveLength(1);
    const parent = records.find(
      (record) =>
        record.type === "span" && record.name === "harness.background-graph",
    );
    expect(parent?.spanId).toBeDefined();
    expect(preparations[0]?.parentSpanId).toBe(parent?.spanId);
    expect(preparations[0]?.attributes).toMatchObject({
      "harness.commit": fixture.first,
    });
    expect(result.made).toBe(true);
    expect(owners).toEqual(["background-graph:preparation"]);
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    restoreBudgetDirectory(directory, previous);
    await host.close();
    await removeOwnRoots(created);
  }
}, 30000);

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { runPreparationChild } from "../src/commit-prepare.ts";

for (const outage of ["departed host", "recovery floor"] as const) {
  test(`preparation finishes after ${outage} without inventing an inherited socket`, async () => {
    const directory = join(root, outage.replaceAll(" ", "-"));
    const previous = process.env.NEUVE_BUDGET_DIRECTORY;
    process.env.NEUVE_BUDGET_DIRECTORY = directory;
    let lock: Database | undefined;
    if (outage === "departed host") {
      const host = await hostBudget({ directory, threads: 4, fixed: 4 });
      if (!host) throw new Error("No host");
      await workerBudget(directory);
      await host.close();
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      lock = new Database(join(directory, "budget.sqlite"), { create: true });
      lock.exec("BEGIN IMMEDIATE");
    }
    const created: string[] = [];
    try {
      const repo = await fixtureRepository();
      created.push(repo.root);
      const output = join(directory, "child.json");
      await Effect.runPromise(
        runPreparationChild(
          {
            repository: repo.root,
            command: [
              process.execPath,
              join(import.meta.dir, "fixtures/capacity-preparation.ts"),
            ],
          },
          [
            repo.root,
            join(directory, "store"),
            output,
            JSON.stringify({
              kind: "range",
              range: { baseOid: repo.first, headOid: repo.second },
            }),
          ],
        ).pipe(Effect.provideService(Worker.Running, true)),
      );
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result.gomax).toBeDefined();
      if (outage === "recovery floor") {
        expect(result).toEqual({ permits: null, inherited: false, gomax: "1" });
      } else {
        expect(result.inherited).toBe(true);
        expect(result.permits).toBeGreaterThan(0);
      }
    } finally {
      lock?.close();
      await closeWorkerBudget(directory);
      restoreBudgetDirectory(directory, previous);
      await removeOwnRoots(created);
    }
  }, 30000);
}

import { existsSync, writeFileSync } from "node:fs";
import { withCodeWork } from "../src/code-work.ts";
import { storeLocationIn } from "@neuve/records-core";

// A preparation asks for `availableParallelism()` permits (runPreparationChild) and a background
// grant is capped at the host's backgroundCap, threads minus a quarter-reserve. With four threads
// it holds three, and the review's two cannot fit beside them. A two-CPU runner asks for only two,
// which would fit beside the review's two in four threads, so the host there has three threads
// (background cap two, interactive cap two): the preparation still holds all it may, and the review
// still cannot be admitted until it releases them.
const machine = availableParallelism();
const yieldThreads = machine >= 3 ? 4 : 3;
const preparationPermits = Math.min(machine, yieldThreads - 1);
test("a paused preparation releases its three permits before a review requests two, then re-admits", async () => {
  const directory = join(root, "yield-budget");
  const host = await hostBudget({
    directory,
    threads: yieldThreads,
    efficiency: yieldThreads,
    fixed: 4,
  });
  if (!host) throw new Error("No host");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  const controller = new AbortController();
  const location = storeLocationIn(join(root, "yield-store"));
  const started = join(directory, "started");
  const finish = join(directory, "finish");
  const requests: number[] = [];
  const admit = host.scheduler.admit.bind(host.scheduler);
  host.scheduler.admit = async (request, signal) => {
    const grant = await admit(request, signal);
    if (request.owner === "commit.prepare") requests.push(grant.permits);
    return grant;
  };
  const child = Effect.runPromise(
    runPreparationChild(
      {
        repository: root,
        location,
        command: [
          process.execPath,
          join(import.meta.dir, "fixtures/capacity-yield.ts"),
        ],
      },
      [location.directory, started, finish],
    ),
    { signal: controller.signal },
  );
  child.catch(() => {});
  try {
    for (let i = 0; !existsSync(started) && i < 500; i++) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    expect((await host.scheduler.observe()).held).toBe(preparationPermits);
    // The review's two do not fit beside the preparation's grant: only its release admits them.
    expect(preparationPermits + 2).toBeGreaterThan(yieldThreads);
    await Effect.runPromise(
      withCodeWork(
        location,
        false,
        Effect.gen(function* () {
          const result = yield* cpuPool("review", 2, (permits) =>
            Effect.succeed(permits),
          ).pipe(
            Effect.provideService(CpuWork, {
              budget: host.scheduler,
              priority: {
                class: "interactive",
                position: "understand",
                stage: 0,
              },
              inherited: false,
            }),
            Effect.timeoutOption(1000),
          );
          expect(Option.getOrUndefined(result)).toBe(2);
          expect(
            (yield* Effect.promise(() => host.scheduler.observe())).held,
          ).toBe(0);
        }),
      ),
    );
    for (
      let i = 0;
      readFileSync(started, "utf8").trim().split("\n").length < 2 && i < 500;
      i++
    )
      await Bun.sleep(10);
    expect(readFileSync(started, "utf8").trim().split("\n")).toHaveLength(2);
    writeFileSync(finish, "done");
    await child;
    expect(requests).toEqual([preparationPermits, preparationPermits]);
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    controller.abort();
    await child.catch(() => {});
    await host.close();
    await closeWorkerBudget(directory);
    restoreBudgetDirectory(directory, previous);
  }
}, 20000);

import { cpuJob, cpuWork } from "../src/budget/cpu.ts";
for (const boundary of ["work", "pool", "job"] as const) {
  test(`an ordinary CPU ${boundary} joins or uses the floor without becoming a host`, async () => {
    const directory = join(root, `client-${boundary}`);
    const previous = process.env.NEUVE_BUDGET_DIRECTORY;
    process.env.NEUVE_BUDGET_DIRECTORY = directory;
    try {
      const work =
        boundary === "work"
          ? cpuWork("client", Effect.succeed("done"))
          : boundary === "pool"
            ? cpuPool("client", 4, (permits) =>
                Effect.sync(() => {
                  expect(permits).toBe(1);
                  return "done";
                }),
              )
            : cpuJob(
                { class: "preparation", position: "new", stage: 0 },
                cpuWork("client", Effect.succeed("done")),
              );
      expect(await Effect.runPromise(work)).toBe("done");
      expect(existsSync(join(directory, "budget.sqlite"))).toBe(false);
    } finally {
      await closeWorkerBudget(directory);
      restoreBudgetDirectory(directory, previous);
    }
  });
}

import { Worker, JobQueue, Computations } from "@neuve/records-core";
import { jobBudget } from "../src/budget/local.ts";
import { runIn, value } from "./pi/capture/fixture.ts";

test("a real worker job elects and re-elects after host loss", async () => {
  const directory = join(root, "worker-election");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  const location = storeLocationIn(join(root, "worker-election-store"));
  let admissions = 0;
  try {
    const exit = value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "elect" });
          return yield* Worker.run({
            location,
            idleTimeout: "20 millis",
            pollInterval: "10 millis",
            handlers: {
              "review.run": () =>
                Effect.gen(function* () {
                  for (let i = 0; i < 2; i++) {
                    const budget = yield* jobBudget;
                    const grant = yield* Effect.promise(() =>
                      budget.admit({
                        owner: "worker-job",
                        priority: {
                          class: "interactive",
                          position: "understand",
                          stage: 0,
                        },
                        resource: { kind: "cpu", permits: 1 },
                      }),
                    );
                    expect(grant.floor ?? false).toBe(false);
                    yield* Effect.promise(async () => {
                      await grant.release();
                    });
                    admissions++;
                    expect(
                      yield* Effect.promise(() => closeWorkerBudget(directory)),
                    ).toBe(true);
                  }
                }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    expect(admissions).toBe(2);
  } finally {
    await closeWorkerBudget(directory);
    restoreBudgetDirectory(directory, previous);
  }
}, 15000);
