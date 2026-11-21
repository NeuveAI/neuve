// Why: running its own loop is all a coding chat needs, but a review stage also needs a submit tool
// to end its round, a held stage to resume inside its turn, and each request's usage for its context
// ceiling. A runtime that runs its own loop without those must be refused for stages, by name, both
// when a request freezes and when its stage opens, before any session or model request.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { storeLocationIn } from "@neuve/records-core";
import { Cause, Effect, Exit, Scope } from "effect";
import { prepareReviewConfig } from "../../../src/request.ts";
import { fakeRuntime, route } from "./contract-fixture.ts";
import { world } from "./fixture.ts";

const lacking = ["toolEndsTurn", "resumeInTurn", "perMessageUsage"] as const;

// Reason: the freeze must refuse before any work is recorded, naming each missing capability.
test("freezing a Claude route refuses a loop-owning runtime that lacks what stages need", async () => {
  const fake = fakeRuntime([]);
  const capabilities = fake.registry.capabilities(route.account.name);
  const registry = {
    ...fake.registry,
    capabilities: () =>
      Effect.map(capabilities, (caps) => ({
        ...caps,
        toolEndsTurn: false,
        resumeInTurn: false,
        perMessageUsage: false,
      })),
  };
  const exit = await Effect.runPromiseExit(
    prepareReviewConfig({
      location: storeLocationIn("/unused"),
      search: {},
      stack: undefined,
      route,
      runtimes: registry,
    }),
  );
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  expect(error).toMatchObject({
    _tag: "RouteRuntimeMismatch",
    account: route.account.name,
    provider: "claude",
    retryable: false,
    missing: [...lacking],
  });
  expect((error as Error).message).toBe(
    `Account ${route.account.name}'s runtime runs its own loop but can't run review stages: it lacks ending a turn from a tool, resuming inside a turn, usage for each message.`,
  );
  expect(fake.opens()).toBe(0);
  expect(fake.probes()).toBe(0);
});

// Reason: a stage opened from an earlier freeze must refuse too, without a session or a model call;
// one missing capability is enough.
for (const missing of lacking)
  test(`a Claude stage refuses a loop-owning runtime without ${missing}`, async () => {
    // Lower case: the name is in the step's operation name, which a computation key checks.
    const run = await world(`stage-capabilities-${missing.toLowerCase()}`);
    run.ctx.config.route = route;
    run.runtime.policy.ownsLoop = true;
    run.runtime.policy.lacking = [missing];
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const outcome = (await opened.harness.waitForTask(id, context)).state
        .outcome;
      if (outcome.status !== "failed")
        throw new Error("expected failed outcome");
      expect(outcome.error.detail).toMatchObject({
        tag: "RouteRuntimeMismatch",
        account: route.account.name,
        provider: "claude",
        retryable: false,
        missing: [missing],
      });
      expect(run.sent).toEqual([]);
      expect(run.runtime.calls).toEqual([route.account.name]);
      expect(run.runtime.sessionOpens()).toBe(0);
    } finally {
      await opened.harness.close(context);
      await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
    }
  });

// Reason: the worker now registers the Codex runtime, so a review naming an account on it reaches
// this check with Codex's own declared capabilities: refused by name, before any session.
test("freezing a route on the Codex runtime's capabilities refuses it, naming what it lacks", async () => {
  const { capabilities: codex } = await import("@neuve/runtime-codex");
  const fake = fakeRuntime([]);
  const exit = await Effect.runPromiseExit(
    prepareReviewConfig({
      location: storeLocationIn("/unused"),
      search: {},
      stack: undefined,
      route,
      runtimes: { ...fake.registry, capabilities: () => Effect.succeed(codex) },
    }),
  );
  expect(
    Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
  ).toMatchObject({
    _tag: "RouteRuntimeMismatch",
    missing: [...lacking],
  });
  expect(fake.opens()).toBe(0);
});
