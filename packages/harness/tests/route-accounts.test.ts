import { expect, test } from "bun:test";
import { Option } from "effect";
import { canonicalJson } from "@neuve/records-core";
import { AccountName } from "@neuve/runtime";
import { defaultConfig, PipelineConfig, runKeyFor } from "../src/config.ts";
import { namedRoute, settingsRoute } from "../src/request.ts";
import {
  ClaudeRouteConfig,
  AnyRouteConfig,
  OPUS_ROUTE,
  SOL_ROUTE,
  RouteConfig,
  routeAccount,
  routeByName,
} from "../src/route.ts";
import { Settings } from "../src/settings.ts";

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

// Why: default account metadata must not split the same review into two runs.
// These keys pin that identity for the current pipeline.
test.each([
  [
    OPUS_ROUTE,
    "d9ff25efaa3d8ee17aadff833e6dcf2996118dd1a256320bd259959c4fcb651a",
  ],
  [
    SOL_ROUTE,
    "1f5ac2f6296d668cafd7f0d5bf4a9e77ae95ede9f32d80d794ef59026536a408",
  ],
] as const)(
  "the default $provider route keeps its base run key",
  (route, key) => {
    const { account: _account, ...legacy } = route;
    expect(runKeyFor(range, defaultConfig(undefined, route))).toBe(key);
    expect(runKeyFor(range, defaultConfig(undefined, legacy))).toBe(key);
  },
);

// Why: frozen-request identity compares canonical JSON; parsing must not fill in an account.
test.each([
  [OPUS_ROUTE, { name: "anthropic", kind: "anthropic-api-key" }],
  [SOL_ROUTE, { name: "chatgpt", kind: "chatgpt-subscription" }],
] as const)(
  "legacy $provider routes preserve their frozen identity",
  (route, expected) => {
    const { account: _account, ...legacy } = route;
    const parsed = RouteConfig.parse(legacy);
    expect(canonicalJson(parsed)).toBe(canonicalJson(legacy));
    expect(Object.hasOwn(parsed, "account")).toBe(false);
    expect<unknown>(routeAccount(parsed)).toEqual(expected);
    const config = defaultConfig(undefined, legacy);
    expect(canonicalJson(PipelineConfig.parse(config))).toBe(
      canonicalJson(config),
    );
  },
);

test("a legacy custom credential has no inferred account", () => {
  const { account: _account, ...legacy } = OPUS_ROUTE;
  expect(
    routeAccount({ ...legacy, credentialVariable: "OTHER_API_KEY" }),
  ).toBeUndefined();
});

test("new requests freeze their account through named and settings routes", () => {
  expect<unknown>(settingsRoute(Option.none()).account).toEqual({
    name: "anthropic",
    kind: "anthropic-api-key",
  });
  const settings = Option.some(
    Settings.parse({
      version: 1,
      review: { route: "openai", effort: "high", reasoningSummaries: true },
    }),
  );
  for (const route of [
    namedRoute("openai", settings),
    settingsRoute(settings),
    routeByName("openai", "high", true),
  ]) {
    expect<unknown>(route.account).toEqual({
      name: "chatgpt",
      kind: "chatgpt-subscription",
    });
    expect(canonicalJson(RouteConfig.parse(route))).toBe(canonicalJson(route));
    const config = defaultConfig(undefined, route);
    expect(canonicalJson(PipelineConfig.parse(config))).toBe(
      canonicalJson(config),
    );
  }
});

// Why: a provider must refuse an account kind that its route cannot serve.
test.each([OPUS_ROUTE, SOL_ROUTE])(
  "$provider refuses mismatched account kinds",
  (route) => {
    const accepted =
      route.provider === "anthropic"
        ? "anthropic-api-key"
        : "chatgpt-subscription";
    for (const kind of [
      "claude-subscription",
      "anthropic-api-key",
      "chatgpt-subscription",
      "openai-api-key",
    ]) {
      expect(
        RouteConfig.safeParse({ ...route, account: { name: "other", kind } })
          .success,
      ).toBe(kind === accepted);
    }
  },
);

// Why: the compatibility rule must not collapse work requested on different accounts.
test.each([OPUS_ROUTE, SOL_ROUTE])(
  "$provider keys non-default accounts apart",
  (route) => {
    const other = RouteConfig.parse({
      ...route,
      account: { ...route.account, name: "other" },
    });
    expect<unknown>(routeAccount(other)).toEqual({
      name: "other",
      kind: route.account?.kind,
    });
    expect(runKeyFor(range, defaultConfig(undefined, other))).not.toBe(
      runKeyFor(range, defaultConfig(undefined, route)),
    );
  },
);

test("a default account name on a custom credential remains keyed", () => {
  const route = { ...OPUS_ROUTE, credentialVariable: "OTHER_API_KEY" };
  const { account: _account, ...legacy } = route;
  expect(runKeyFor(range, defaultConfig(undefined, route))).not.toBe(
    runKeyFor(range, defaultConfig(undefined, legacy)),
  );
});

// Why: a subscription route must carry its account and cannot acquire a direct credential field.
test("Claude routes require a subscription account and no price or credential", () => {
  const route: ClaudeRouteConfig = {
    provider: "claude",
    account: {
      name: AccountName.parse("claude-personal"),
      kind: "claude-subscription",
    },
    model: OPUS_ROUTE.model,
    effort: OPUS_ROUTE.effort,
    window: OPUS_ROUTE.window,
    maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
    price: null,
  };
  const parsed = ClaudeRouteConfig.parse(route);
  expect(parsed).toEqual(route);
  expect(AnyRouteConfig.parse(route)).toEqual(route);
  expect(RouteConfig.parse(route)).toEqual(route);
  expect(PipelineConfig.parse(defaultConfig(undefined, route)).route).toEqual(
    route,
  );
  const other = {
    ...route,
    account: { ...route.account, name: AccountName.parse("other-claude") },
  };
  expect(runKeyFor(range, defaultConfig(undefined, other))).not.toBe(
    runKeyFor(range, defaultConfig(undefined, route)),
  );
  expect(routeAccount(parsed)).toEqual(route.account);
  const { account: _account, ...missing } = route;
  expect(ClaudeRouteConfig.safeParse(missing).success).toBe(false);
  for (const kind of [
    "anthropic-api-key",
    "chatgpt-subscription",
    "openai-api-key",
  ])
    expect(
      ClaudeRouteConfig.safeParse({
        ...route,
        account: { name: "other", kind },
      }).success,
    ).toBe(false);
  for (const extra of [
    { credentialVariable: "FAKE_KEY" },
    { credentialSource: "claude-code-sign-in" },
    { price: OPUS_ROUTE.price },
  ])
    expect(ClaudeRouteConfig.safeParse({ ...route, ...extra }).success).toBe(
      false,
    );
});
