import { expect, test } from "bun:test";
import { Computations } from "@neuve/records-core";
import { DEFAULT_ACCOUNTS } from "@neuve/runtime";
import {
  defaultConfig,
  type PipelineConfig,
  runKeyFor,
} from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  ClaudeRouteConfig,
  RouteConfig,
  type AnyRouteConfig,
  computationRoute,
  credentialName,
  routeCredentialVariable,
  SubscriptionRouteRequiresRuntime,
} from "../src/route.ts";

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

// Why: who pays separates runs, while identical stage computations remain reusable across accounts.
test("accounts of the same kind share agent-stage keys and have different run keys", () => {
  const stageKey = (config: PipelineConfig) =>
    Computations.computationKey(
      agentStageSpec(
        config,
        { stage: "verify", turnLimit: 15, agent: "dispose.b1.u1" },
        {
          op: "harness.dispose",
          opVersion: 4,
          inputs: { unit: "computation:u" },
        },
      ),
    ).key;

  for (const route of [OPUS_ROUTE, SOL_ROUTE]) {
    const other = RouteConfig.parse({
      ...route,
      account: { ...route.account, name: "other" },
    });
    const config = defaultConfig(undefined, route);
    const otherConfig = defaultConfig(undefined, other);
    expect(stageKey(otherConfig)).toBe(stageKey(config));
    expect(runKeyFor(range, otherConfig)).not.toBe(runKeyFor(range, config));
  }
});

// Why: frozen default routes must name accounts the default directory supplies, with matching kinds.
test("default route accounts match the runtime's default account declarations", () => {
  for (const route of [OPUS_ROUTE, SOL_ROUTE]) {
    expect(
      DEFAULT_ACCOUNTS.some(
        ({ name, kind }) =>
          name === route.account?.name && kind === route.account?.kind,
      ),
    ).toBe(true);
  }
});

// Why: Claude loop identity separates stage keys, independently of the subscription account.
test("Claude stages separate from API stages and reuse across subscription accounts", () => {
  const claude = ClaudeRouteConfig.parse({
    provider: "claude",
    account: { name: "claude", kind: "claude-subscription" },
    model: OPUS_ROUTE.model,
    effort: OPUS_ROUTE.effort,
    window: OPUS_ROUTE.window,
    maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
    price: null,
  });
  const other = ClaudeRouteConfig.parse({
    ...claude,
    account: { ...claude.account, name: "other" },
  });
  const key = (route: AnyRouteConfig) =>
    Computations.computationKey({
      ...agentStageSpec(
        defaultConfig(),
        { stage: "verify", turnLimit: 15, agent: "dispose.b1.u1" },
        {
          op: "harness.dispose",
          opVersion: 4,
          inputs: { unit: "computation:u" },
        },
      ),
      route: computationRoute(route),
    }).key;
  expect(computationRoute(claude)).toEqual({
    provider: "claude",
    model: OPUS_ROUTE.model,
    reasoning: "medium",
  });
  expect(key(claude)).not.toBe(key(OPUS_ROUTE));
  expect(key(claude)).toBe(key(other));
  expect(credentialName(claude)).toBe(
    "the Claude Code sign-in of account claude",
  );
  expect(() => routeCredentialVariable(claude)).toThrow(
    SubscriptionRouteRequiresRuntime,
  );
  expect(routeCredentialVariable(OPUS_ROUTE)).toBe("ANTHROPIC_API_KEY");
  expect(routeCredentialVariable(SOL_ROUTE)).toBeUndefined();
});
