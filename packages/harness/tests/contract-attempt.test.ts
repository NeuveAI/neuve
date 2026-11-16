// Why: admitting a subscription route must never construct a direct transport or inspect its
// credential source. The attempt must use the session's continuation identity for its budget.
import { mkdirSync } from "node:fs";
import { expect, spyOn, test } from "bun:test";
import { Effect, Exit, Scope, Layer } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { Context } from "effect";
import * as admission from "../src/pi/providers/route-admission.ts";
import * as provider from "../src/pi/providers/agent-route-provider.ts";
import * as counter from "../src/pi/providers/count-tokens.ts";
import * as fetchBudget from "../src/budget/fetch.ts";
import * as host from "../src/pi/host.ts";
import * as stages from "../src/pi/stages/index.ts";
import { openAttempt } from "../src/pi/attempt.ts";
import { continuationAccountKey } from "../src/pi/session-slots.ts";
import { SourceOwnership } from "../src/pi/source-ownership.ts";
import { runFolder } from "../src/run-folder.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { fakeRuntime, route } from "./pi/stages/contract-fixture.ts";
import { world } from "./pi/stages/fixture.ts";

test("a loop-owning attempt skips all direct route setup and supplies a null count", async () => {
  const run = await world("contract-attempt");
  run.ctx.config.route = route;
  const fake = fakeRuntime([]);
  const opened = await run.open();
  mkdirSync(runFolder(run.ctx.location, run.ctx.runId), {
    recursive: true,
    mode: 0o700,
  });
  const ownership = SourceOwnership.acquire(
    runFolder(run.ctx.location, run.ctx.runId),
  );
  const budget = new Scheduler(8, 8, 8);
  const active: string[] = [];
  let released = 0;
  const sentinel = new Error("finish inspected startup");
  const forbid = () => {
    throw new Error("direct route setup must not run");
  };
  const direct = [
    spyOn(admission, "providerAccountKey").mockImplementation(forbid),
    spyOn(provider, "createAgentRouteProvider").mockImplementation(forbid),
    spyOn(counter, "createCountTokens").mockImplementation(forbid),
    spyOn(fetchBudget, "budgetFetch").mockImplementation(forbid),
  ];
  const originalStages = stages.reviewStages;
  const services: stages.StageServices[] = [];
  const stageSpy = spyOn(stages, "reviewStages").mockImplementation((input) => {
    services.push(input);
    return originalStages(input);
  });
  const hostSpy = spyOn(host, "openReviewHost").mockImplementation(
    async (options) => {
      try {
        expect(options.models.getProviders()).toEqual([]);
        options.stages({
          harness: opened.harness,
          routes: {
            bindAgentRoute: async () => forbid(),
            prepareFinalGeneration: async () => forbid(),
            readBinding: async () => forbid(),
            restoreAgentRoutes: async () => {},
          },
        });
        const service = services[0];
        if (service?.countTokens === undefined)
          throw new Error("Missing count policy");
        expect(
          await service.countTokens({
            label: "frame",
            system: "",
            user: "",
            tools: [],
          }),
        ).toBeNull();
      } finally {
        await options.storage.close(context);
      }
      throw sentinel;
    },
  );
  try {
    const clients = Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(
          mcpClientsLayer({ status: "absent", path: "(none)" }),
          run.scope,
        ),
      ),
      McpClients,
    );
    await expect(
      openAttempt({
        ctx: run.ctx,
        generation: 0,
        ownership,
        claim: { jobSeq: 1, attempt: 1, claimedAt: new Date().toISOString() },
        integrations: { status: "absent", path: "(none)" },
        clients,
        runtimes: fake.registry,
        budget: {
          admit: budget.admit.bind(budget),
          throttle: budget.throttle.bind(budget),
          capacity: budget.capacity.bind(budget),
          observe: budget.observe.bind(budget),
          activate: async (account) => {
            active.push(account);
            return () => {
              released++;
            };
          },
        },
        runSlot: (effect, signal) => Effect.runPromise(effect, { signal }),
      }),
    ).rejects.toBe(sentinel);
    expect(active).toEqual([
      continuationAccountKey({
        runtime: "claude-code",
        key: "fake-account-identity",
      }),
    ]);
    expect(released).toBe(1);
    expect(hostSpy).toHaveBeenCalledTimes(1);
    for (const spy of direct) expect(spy).not.toHaveBeenCalled();
    expect(fake.opens()).toBe(0);
  } finally {
    hostSpy.mockRestore();
    stageSpy.mockRestore();
    for (const spy of direct) spy.mockRestore();
    ownership.release();
    await opened.harness.close(context);
    await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
  }
});
