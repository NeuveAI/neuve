import { AccountName } from "@neuve/runtime";
import { buildReceipt } from "../src/receipt.ts";
import { defaultConfig } from "../src/config.ts";
import { OPUS_ROUTE, SOL_ROUTE, routeAccount } from "../src/route.ts";
import { expect, test } from "bun:test";
import { RunReceipt } from "@neuve/records-schema";

const receipt = {
  runKey: "f".repeat(64),
  generation: 0,
  jobSeq: 1,
  route: {
    provider: "claude",
    model: "fake",
    effort: "medium",
    maxOutputTokens: 10,
    contextCeiling: 100,
    callsInFlight: 1,
    credentialSource: "neuve-sign-in",
    organization: null,
    price: {},
  },
  outcome: "completed",
  timeout: {
    lifetimeMs: 1000,
    cutoffAt: "2026-11-10T12:00:00Z",
    reached: false,
    published: [],
    disclosed: [],
  },
  timing: {
    enqueuedAt: "2026-11-10T12:00:00Z",
    startedAt: "2026-11-10T12:00:00Z",
    endedAt: "2026-11-10T12:00:00Z",
    wallMs: 0,
    queueWaitMs: 0,
    attempts: 1,
  },
  stages: [],
  totals: {
    modelCalls: 0,
    retries: 0,
    usage: {
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
    },
    costUsd: null,
  },
  gaps: [],
  disclosures: [],
  notMeasured: {},
};
// Reason: account attribution must preserve old receipts and the existing credential rule.
test("receipts accept no account or any of the four account kinds, and refuse invalid identity or credentials", () => {
  expect(RunReceipt.safeParse(receipt).success).toBe(true);
  for (const kind of [
    "claude-subscription",
    "anthropic-api-key",
    "chatgpt-subscription",
    "openai-api-key",
  ] as const) {
    const account = { name: "work", kind };
    const parsed = RunReceipt.parse({
      ...receipt,
      route: { ...receipt.route, account },
    });
    expect(parsed.route.account).toEqual(account);
  }
  for (const account of [
    { name: "work", kind: "bad" },
    { name: "../bad", kind: "claude-subscription" },
  ])
    expect(
      RunReceipt.safeParse({ ...receipt, route: { ...receipt.route, account } })
        .success,
    ).toBe(false);
  expect(
    RunReceipt.safeParse({
      ...receipt,
      route: {
        ...receipt.route,
        account: { name: "work", kind: "claude-subscription" },
        credentialVariable: "KEY",
      },
    }).success,
  ).toBe(false);
});

// Reason: attribution must be produced by the real receipt builder for explicit and legacy routes, while the text receipt stays compatible.
test("built receipts carry the route account for explicit and legacy routes and still parse", () => {
  const { account: _account, ...legacy } = SOL_ROUTE;
  const { account: _default, ...legacyAnthropic } = OPUS_ROUTE;
  for (const route of [
    SOL_ROUTE,
    {
      ...SOL_ROUTE,
      account: {
        name: AccountName.parse("work"),
        kind: "chatgpt-subscription" as const,
      },
    },
    legacy,
    legacyAnthropic,
  ]) {
    const built = buildReceipt({
      runId: "run",
      runKey: "f".repeat(64),
      generation: 0,
      jobSeq: 1,
      range: {
        baseRef: "main",
        baseOid: "b".repeat(40),
        headOid: "a".repeat(40),
      },
      cycleId: "cycle",
      config: defaultConfig(undefined, route),
      enqueuedAt: new Date(1000).toISOString(),
      startedAt: 2000,
      endedAt: 3000,
      stages: [],
      records: [],
    });
    expect(built.route.account).toEqual(routeAccount(route));
    const {
      type: _type,
      runId: _runId,
      range: _range,
      cycleId: _cycleId,
      ...payload
    } = built;
    expect(RunReceipt.parse(payload).route.account).toEqual(
      routeAccount(route),
    );
  }
});
