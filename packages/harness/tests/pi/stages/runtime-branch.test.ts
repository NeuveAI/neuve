// Why: dispatch must preserve provider agreement and run loop-owning accounts through real attempt wiring.
import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { AccountName, RuntimeUnavailable } from "@neuve/runtime";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Effect, Exit, Scope } from "effect";
import { ClaudeRouteConfig, OPUS_ROUTE } from "../../../src/route.ts";
import { stageRouteError } from "../../../src/pi/stages/agent-step.ts";
import { openAttempt, type OpenedAttempt } from "../../../src/pi/attempt.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { runFolder } from "../../../src/run-folder.ts";
import { Scheduler } from "../../../src/budget/scheduler.ts";
import { readCaptureJournal } from "../../../src/pi/capture/journal.ts";
import * as kinds from "../../../src/pi/stages/kinds.ts";
import { fakeRuntime, route, submit, usage } from "./contract-fixture.ts";
import { world, settled } from "./fixture.ts";

const claude = ClaudeRouteConfig.parse({
  provider: "claude",
  account: { name: "claude", kind: "claude-subscription" },
  model: OPUS_ROUTE.model,
  effort: OPUS_ROUTE.effort,
  window: OPUS_ROUTE.window,
  maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
  price: null,
});

test("Claude branch refuses a runtime that does not own its loop", () => {
  expect(stageRouteError(claude, false)).toMatchObject({
    _tag: "RouteRuntimeMismatch",
    account: claude.account.name,
    retryable: false,
    provider: "claude",
  });
});

test("a Claude route on a loop-owning account runs the contract engine through openAttempt", async () => {
  const run = await world("runtime-claude-attempt");
  run.ctx.config.route = route;
  const fake = fakeRuntime([
    async (turn) => {
      const item = submit("attempt-submit", 7);
      await turn.message([item]);
      await turn.charge(usage);
      expect((await turn.invoke(item)).endTurn).toBe(true);
    },
  ]);
  // Only agent preparation is synthetic. openAttempt supplies the services and session slots.
  const originalKinds = kinds.agentKinds;
  let step: kinds.AgentKinds["agentStep"] | undefined;
  const prepare = spyOn(kinds, "agentKinds").mockImplementation((services) => {
    const agents = originalKinds(services, {
      prepare: async () => run.agentFor(),
    });
    step = agents.agentStep;
    return agents;
  });
  const source = runFolder(run.ctx.location, run.ctx.runId);
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const ownership = SourceOwnership.acquire(source);
  let opened: OpenedAttempt | undefined;
  try {
    opened = await openAttempt({
      ctx: run.ctx,
      generation: 0,
      ownership,
      claim: { jobSeq: 1, attempt: 1, claimedAt: new Date().toISOString() },
      integrations: { status: "absent", path: "(none)" },
      clients: run.clients,
      runtimes: fake.registry,
      budget: new Scheduler(8, 8, 8),
      runSlot: (effect, signal) => Effect.runPromise(effect, { signal }),
      fetch: Object.assign(
        async () => {
          throw new Error("A Claude stage must not use direct transport");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    });
    // Isolate stage dispatch from the review's unrelated repository preparation.
    await opened.host.stop(context, 5_000);
    const task = step;
    if (task === undefined)
      throw new Error("The attempt did not install stages");
    const { host } = opened;
    const id = await host.harness.commit(
      (tx) =>
        tx.createTask(
          task,
          { kind: "frame", params: {}, cutoffAt: Date.now() + 60_000 },
          {
            ownership: { kind: "conversation" },
            conversationId: host.admission.conversationId,
          },
        ),
      context,
    );
    const record = await settled(opened.host.harness, id);
    expect(record).toMatchObject({
      status: "computed",
      agentResult: { status: "submitted", turnsUsed: 1, modelCalls: 1 },
    });
    expect(stageRouteError(route, true)).toBeUndefined();
    expect(fake.opens()).toBe(1);
    expect(fake.closes()).toBe(1);
    expect(fake.turns).toHaveLength(1);
    const captured = readCaptureJournal(opened.journal.directory);
    if (captured._tag !== "Read") throw new Error("Invalid attempt journal");
    expect(captured.lines.map((line) => line.event)).toContainEqual(
      expect.objectContaining({
        type: "stage.end",
        scope: expect.objectContaining({ taskId: id, stage: "frame" }),
        status: "completed",
      }),
    );
    expect(run.ctx.log.read()).toContainEqual(
      expect.objectContaining({ type: "stage", ...record }),
    );
  } finally {
    prepare.mockRestore();
    try {
      await opened?.host.close("ended", context);
    } finally {
      ownership.release();
      await Effect.runPromise(Scope.close(run.scope, Exit.void));
    }
  }
});

for (const scenario of [
  {
    name: "api-on-claude",
    route: OPUS_ROUTE,
    ownsLoop: true,
    tag: "RouteRuntimeMismatch",
  },
  {
    name: "missing-runtime",
    route: OPUS_ROUTE,
    ownsLoop: false,
    tag: "RuntimeUnavailable",
  },
]) {
  test(`${scenario.name} fails non-retryably without creating a pi agent conversation`, async () => {
    let counts = 0;
    const run = await world(
      `runtime-${scenario.name}`,
      6,
      false,
      false,
      "faux",
      undefined,
      false,
      {
        countTokens: async () => {
          counts++;
          throw new Error("must not count before runtime dispatch");
        },
      },
    );
    run.ctx.config.route = scenario.route;
    run.runtime.policy.ownsLoop = scenario.ownsLoop;
    if (scenario.name === "missing-runtime")
      run.runtime.policy.error = new RuntimeUnavailable({
        account: AccountName.parse("anthropic"),
        reason: "not-registered",
      });
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const outcome = (await opened.harness.waitForTask(id, context)).state
        .outcome;
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed")
        throw new Error("expected failed outcome");
      expect(outcome.error.detail).toMatchObject({
        tag: scenario.tag,
        retryable: false,
        account: scenario.route.account?.name,
      });
      if (scenario.tag === "RouteRuntimeMismatch")
        expect(outcome.error.detail).toMatchObject({
          provider: scenario.route.provider,
        });
      const conversations = await opened.harness.commit(
        (tx) => tx.scanConversations({}, 32),
        context,
      );
      expect(conversations.items).toHaveLength(1); // Only the task's root exists.
      expect(run.sent).toEqual([]);
      expect(counts).toBe(0);
      expect(run.runtime.calls).toEqual([AccountName.parse("anthropic")]);
      expect(run.runtime.sessionOpens()).toBe(0);
      expect(
        run.events.filter((event) => event.type === "stage.end"),
      ).toMatchObject([{ status: "failed" }]);
    } finally {
      await opened.harness.close(context);
      await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
    }
  });
}

for (const custom of [false, true]) {
  test(`${custom ? "legacy custom" : "account-backed"} pi route keeps the existing generation path and opens no registry session`, async () => {
    const run = await world(`runtime-pi-${custom}`);
    if (custom) {
      const { account: _account, ...legacy } = OPUS_ROUTE;
      run.ctx.config.route = {
        ...legacy,
        credentialVariable: "CUSTOM_FAKE_KEY",
      };
    }
    run.script.push(() =>
      fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
        stopReason: "toolUse",
      }),
    );
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      expect((await settled(opened.harness, id)).status).toBe("computed");
      expect(run.sent).toHaveLength(1);
      expect(run.sent[0]?.mode).toEqual({ kind: "normal" });
      expect(run.runtime.calls).toEqual(
        custom ? [] : [AccountName.parse("anthropic")],
      );
      expect(run.runtime.sessionOpens()).toBe(0);
    } finally {
      await opened.harness.close(context);
      await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
    }
  });
}
