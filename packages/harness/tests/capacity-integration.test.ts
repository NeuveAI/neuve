import { captureOutlineSource } from "../src/graph-outline.ts";
import { budgetFetch } from "../src/budget/fetch.ts";
// CPU pools, child inheritance and provider dispatch cross process and runtime boundaries.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { Scheduler, type Request } from "../src/budget/scheduler.ts";
import { CpuWork, cpuPool, cpuWork } from "../src/budget/cpu.ts";
import { repositoryOwner } from "../src/budget/owner.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { hostBudget, localBudget } from "../src/budget/local.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { runPreparationChild } from "../src/commit-prepare.ts";
import { reviewPriority } from "../src/pi/priority.ts";
import { callSlots, limitProvider } from "../src/pi/call-slots.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
const root = mkdtempSync(join(tmpdir(), "capacity-integration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const recording = (budget: Scheduler) => {
  const requests: Request[] = [];
  const admit = budget.admit.bind(budget);
  budget.admit = (request, signal) => {
    requests.push(request);
    return admit(request, signal);
  };
  return requests;
};
const repository = (parent = root) => {
  const repo = join(parent, crypto.randomUUID());
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-q", repo]);
  for (const n of [1, 2]) {
    writeFileSync(join(repo, "value.ts"), `export const value = ${n};\n`);
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      String(n),
    );
  }
  return {
    repo,
    range: {
      baseOid: git("rev-parse", "HEAD~1"),
      headOid: git("rev-parse", "HEAD"),
    },
  };
};

test("real review precompute pools admit long repository paths and cache hits take none", async () => {
  const directory = mkdtempSync("/tmp/neuve-path-budget-");
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("Fixture budget did not start");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  try {
    const budget = localBudget(directory);
    const requests = recording(host.scheduler);
    const { repo, range } = repository(
      join(root, "nested-checkout-".repeat(6), "nested-worktree-".repeat(6)),
    );
    expect(repo.length).toBeGreaterThan(256);
    const location = storeLocationIn(join(root, "review-store"));
    const run = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      work.pipe(
        Effect.provideService(CpuWork, {
          budget,
          priority: reviewPriority("frame", false),
          inherited: false,
        }),
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      );
    const manifest = rangeManifest(
      repo,
      range,
      defaultManifestSettings(10000),
      captureOutlineSource(),
    );
    await Effect.runPromise(
      run(Effect.andThen(Store.prepareForWrite, manifest)),
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.priority.class === "interactive"),
    ).toBe(true);
    // The leads' search pool, which `rangeManifest` runs after the manifest's own pools.
    expect(requests.some((request) => request.owner === "leads.search")).toBe(
      true,
    );
    expect(
      requests.some((request) => request.owner === repositoryOwner(repo)),
    ).toBe(true);
    const count = requests.length;
    await Effect.runPromise(run(manifest));
    expect(requests).toHaveLength(count);
    expect((await budget.observe()).held).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one pool grant caps descendants without nested acquisition", async () => {
  const budget = new Scheduler(2, 2, 4);
  const requests = recording(budget);
  const permits = await Effect.runPromise(
    cpuPool("pool", 8, (n) => cpuWork("nested", Effect.succeed(n))).pipe(
      Effect.provideService(CpuWork, {
        budget,
        priority: reviewPriority("frame", false),
        inherited: false,
      }),
    ),
  );
  expect(permits).toBe(1);
  expect(requests).toHaveLength(1);
  expect((await budget.observe()).held).toBe(0);
});

test("provider dispatch admits real stage and transcript continuation priorities", async () => {
  const budget = new Scheduler(2, 2, 4);
  const requests = recording(budget);
  const faux = fauxProvider({
    provider: "capacity-fixture",
    models: [{ id: "test" }],
  });
  faux.setResponses(
    Array.from({ length: 5 }, () => fauxAssistantMessage("ok")),
  );
  const slots = callSlots(
    4,
    (work, signal) => Effect.runPromise(work, { signal }),
    {
      budget,
      account: "a".repeat(64),
      owner: "run",
      priority: () => reviewPriority("find", false),
    },
  );
  for (const stage of ["frame", "find", "map", "verify"] as const) {
    const provider = limitProvider(
      faux.provider,
      slots,
      { provider: "fixture", model: "test" },
      (context) =>
        reviewPriority(
          stage,
          context === undefined ||
            context.messages.some((message) => message.role === "assistant"),
        ),
    );
    const model = (await provider.getModels())[0]!;
    for await (const _ of provider.streamSimple(
      model,
      normalizeContext({ messages: [] }),
    )) {
    }
    if (stage === "find")
      for await (const _ of provider.streamSimple(
        model,
        normalizeContext({
          messages: [fauxAssistantMessage("prior")],
        }),
      )) {
      }
  }
  expect(requests.map((request) => request.priority)).toEqual([
    { class: "interactive", position: "understand", stage: 10 },
    { class: "interactive", position: "new", stage: 30 },
    { class: "interactive", position: "continuation", stage: 30 },
    { class: "interactive", position: "understand", stage: 20 },
    { class: "interactive", position: "started", stage: 90 },
  ]);
});

test("preparation spawns under one background grant inherited by its real pools", async () => {
  const directory = join(root, "budget");
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("Fixture budget did not start");
  const requests = recording(host.scheduler);
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  try {
    const { repo, range } = repository();
    const output = join(root, "child.json");
    await Effect.runPromise(
      runPreparationChild(
        {
          repository: repo,
          command: [
            process.execPath,
            join(import.meta.dir, "fixtures/capacity-preparation.ts"),
          ],
        },
        [
          repo,
          join(root, "child-store"),
          output,
          JSON.stringify({ kind: "range", range }),
        ],
      ),
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      permits: 1,
      inherited: true,
      gomax: "1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.priority.class).toBe("preparation");
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await host.close();
  }
  // Graph's cold start under the one-permit grant measured 87 s; allow bounded margin.
}, 120_000);

test("the response owner reports a throttle once even with both signals", async () => {
  const budget = new Scheduler(2, 2, 4);
  const observed: unknown[] = [];
  budget.throttle = async (...args) => {
    observed.push(args);
  };
  const response = new Response(null, {
    status: 429,
    headers: { "retry-after": "1" },
  });
  const fetch = Object.assign(async () => response, {
    preconnect: globalThis.fetch.preconnect,
  });
  expect(
    await budgetFetch(fetch, budget, "a".repeat(64))("https://fixture.invalid"),
  ).toBe(response);
  expect(observed).toEqual([["a".repeat(64), true, true]]);
});
