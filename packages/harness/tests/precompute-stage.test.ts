import { reviewPrecomputeActive } from "../src/code-work.ts";
// Why: the pi boundary must return completed code facts across cycles, and must
// settle at its own deadline even when its caller has not aborted the task.
import { expect, test } from "bun:test";
import { Effect, Context, Layer, Scope, Exit } from "effect";
import { createRegistry } from "@earendil-works/pi-durable";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintUlid, Computations } from "@neuve/records-core";
import { reviewStages } from "../src/pi/stages/index.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { mcpClientsLayer, McpClients } from "../src/mcp-client.ts";
import { world } from "./pi/stages/fixture.ts";
import { treeIndex } from "../src/search-index.ts";

const setup = async (name: string) => {
  const w = await world(name);
  const git = (...args: string[]) => {
    const child = Bun.spawnSync([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      w.root,
      ...args,
    ]);
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init", "-q");
  const commit = () => {
    git("add", "file.ts");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(w.root, "file.ts"), "export const count = 1;\n");
  const baseOid = commit();
  writeFileSync(join(w.root, "file.ts"), "export const count = 2;\n");
  w.ctx.range = { baseRef: "main", baseOid, headOid: commit() };
  const integrations = { status: "absent", path: "(none)" } as const;
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), w.scope),
    ),
    McpClients,
  );
  const services: StageServices = {
    ctx: w.ctx,
    integrations,
    clients,
    registry: createRegistry(),
    routes: {
      bindAgentRoute: async () => {
        throw new Error("No agent is called by Precompute");
      },
      prepareFinalGeneration: async () => {
        throw new Error("No agent is called by Precompute");
      },
    },
    capture: () => {},
    run: stageRunner(w.ctx, clients),
    endRound: async () => {
      throw new Error("No agent is called by Precompute");
    },
  };
  return { w, services };
};

test("two precompute cycles share code facts while keeping separate scope snapshots", async () => {
  const { w, services } = await setup("precompute-cycles");
  try {
    const first = await reviewStages(services).precompute();
    expect(first.facts?.output.hunks).toBe(1);
    w.ctx.cycleId = mintUlid();
    const second = await reviewStages(services).precompute();
    expect(second.facts?.output.manifest).toBe(first.facts?.output.manifest);
    expect(second.facts?.output.scope).not.toBe(first.facts?.output.scope);
    expect(
      w.ctx.log
        .read()
        .filter((r) => r.type === "precompute.manifest")
        .map((r) => r.status),
    ).toEqual(["computed", "reused"]);
  } finally {
    await Effect.runPromise(Scope.close(w.scope, Exit.void));
  }
});

// Why: a repeated review of the same range reuses the stage's stored output, and must still retry
// Graph for the tree indexes a previous review in this process kept degraded.
test("a reused precompute still forgets this process's degraded tree indexes", async () => {
  const { w, services } = await setup("precompute-forgets-degraded");
  const missing = join(w.root, "missing-graph");
  const source = { executable: missing, key: { unavailable: missing } };
  const tree = Bun.spawnSync(["git", "-C", w.root, "rev-parse", "HEAD^{tree}"])
    .stdout.toString()
    .trim();
  const index = () =>
    Effect.runPromise(
      treeIndex(w.root, tree, source).pipe(Effect.provide(w.ctx.records)),
    );
  try {
    await reviewStages(services).precompute();
    const degraded = await index();
    expect(degraded.index.chunks[0]?.fallback).toBe("capability-unavailable");
    expect((await index()).cached).toBe(true);
    const again = await reviewStages(services).precompute();
    expect(again.facts?.output.hunks).toBe(1);
    // The stage's stored output was reused: its manifest step did not run again.
    expect(
      w.ctx.log.read().filter((r) => r.type === "precompute.manifest"),
    ).toHaveLength(1);
    expect((await index()).cached).toBe(false);
  } finally {
    await Effect.runPromise(Scope.close(w.scope, Exit.void));
  }
});

test("precompute settles with no facts when its deadline or caller signal interrupts it", async () => {
  const { w, services } = await setup("precompute-deadline");
  try {
    const result = await reviewStages(services).precompute(
      undefined,
      Date.now(),
    );
    expect(result.record.status).toBe("skipped");
    expect(result.facts).toBeUndefined();
    expect(w.ctx.log.read()).toContainEqual(
      expect.objectContaining({
        type: "precompute.interrupted",
        phase: expect.any(String),
      }),
    );
    expect(w.sent).toHaveLength(0);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await reviewStages(services).precompute(abort.signal);
    expect(cancelled.record.status).toBe("skipped");
    expect(cancelled.facts).toBeUndefined();
  } finally {
    await Effect.runPromise(Scope.close(w.scope, Exit.void));
  }
});

// A caller's later explicit deadline must also extend preparation's yield marker.
test("the review marker lasts through the explicit precompute deadline", async () => {
  const { w, services } = await setup("precompute-later-deadline");
  const cutoff = Date.now() + 150;
  w.ctx.startedAt = cutoff - w.ctx.config.budgets.cutoffMs;
  const store = Context.get(w.ctx.records, Computations.ComputationStore);
  let inspected = false;
  w.ctx.records = Context.add(w.ctx.records, Computations.ComputationStore, {
    ...store,
    run: (spec, compute) =>
      store.run(
        spec,
        spec.op !== "harness.precompute"
          ? compute
          : Effect.gen(function* () {
              yield* Effect.sleep(Math.max(0, cutoff + 60 - Date.now()));
              inspected = true;
              expect(reviewPrecomputeActive(w.ctx.location.directory)).toBe(
                true,
              );
              return yield* compute;
            }),
      ),
  });
  try {
    await reviewStages(services).precompute(undefined, cutoff + 1000);
    expect(inspected).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(w.scope, Exit.void));
  }
});

import { hostBudget, closeWorkerBudget } from "../src/budget/local.ts";
import type { Request } from "../src/budget/scheduler.ts";

test("stageRunner and precomputeStage admit real review pools at Understand priority", async () => {
  const { w, services } = await setup("precompute-admission");
  const directory = join(w.root, "budget");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  const host = await hostBudget({ directory, threads: 4, fixed: 4 });
  if (!host) throw new Error("No host");
  const requests: Request[] = [];
  const admit = host.scheduler.admit.bind(host.scheduler);
  host.scheduler.admit = (request, signal) => {
    requests.push(request);
    return admit(request, signal);
  };
  try {
    const result = await reviewStages(services).precompute();
    expect(result.facts?.output.hunks).toBe(1);
    // Precompute's own pool; the leads' pools run in the leads task now, not here (NEU-148).
    expect(
      requests.some((request) => request.owner === "precompute.hunks"),
    ).toBe(true);
    expect(requests.some((request) => request.owner.startsWith("leads."))).toBe(
      false,
    );
    expect(
      requests.every(
        (request) =>
          request.priority.class === "interactive" &&
          request.priority.position === "understand",
      ),
    ).toBe(true);
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    await host.close();
    await closeWorkerBudget(directory);
    await Effect.runPromise(Scope.close(w.scope, Exit.void));
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
  }
});
