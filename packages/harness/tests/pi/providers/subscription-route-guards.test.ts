// Why: a subscription route must fail before direct consumers inspect credentials, files or transport.
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  ClaudeRouteConfig,
  OPUS_ROUTE,
  requireDirectRoute,
  SubscriptionRouteRequiresRuntime,
} from "../../../src/route.ts";
import { credentialPresent } from "../../../src/route-provider.ts";
import {
  createAgentRouteProvider,
  createRouteModels,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { createCountTokens } from "../../../src/pi/providers/count-tokens.ts";
import {
  openRouteAdmission,
  providerAccountKey,
} from "../../../src/pi/providers/route-admission.ts";
import { routeModel } from "../../../src/pi/providers/route-model.ts";

test("every direct entry point refuses Claude before any credential, admission or fetch access", () => {
  const route = ClaudeRouteConfig.parse({
    provider: "claude",
    account: { name: "claude", kind: "claude-subscription" },
    model: OPUS_ROUTE.model,
    effort: OPUS_ROUTE.effort,
    window: OPUS_ROUTE.window,
    maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
    price: null,
  });
  const touched: string[] = [];
  const forbidden = (name: string): never => {
    touched.push(name);
    throw new Error(name);
  };
  const fetcher: typeof fetch = Object.assign(async () => forbidden("fetch"), {
    preconnect: globalThis.fetch.preconnect,
  });
  const options = {
    route,
    fetch: fetcher,
    runId: "guard",
    sessionAffinity: "guard",
    capture: () => forbidden("capture"),
    credentialInspection: "ephemeral" as const,
  };
  const entrypoints = [
    () => requireDirectRoute(route),
    () => credentialPresent(route),
    () => createRouteModels(options),
    () =>
      createAgentRouteProvider({
        ...options,
        logicalProvider: "guard",
        readBinding: async () => forbidden("binding"),
      }),
    () => createCountTokens(options),
    () => providerAccountKey({ route }),
    () => openRouteAdmission({ route, path: "/does-not-exist/admission" }),
    // This deliberately exercises the descriptor's runtime guard through an untyped call boundary.
    () => Reflect.apply(routeModel, undefined, [route]),
  ];
  const environment = process.env;
  const reads = spyOn(fs, "readFileSync").mockImplementation(() =>
    forbidden("readFileSync"),
  );
  const requests = spyOn(globalThis, "fetch").mockImplementation(fetcher);
  const failures: unknown[] = [];
  try {
    process.env = new Proxy(environment, {
      get: () => forbidden("environment"),
    });
    for (const enter of entrypoints) {
      try {
        enter();
        failures.push(undefined);
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    process.env = environment;
    reads.mockRestore();
    requests.mockRestore();
  }
  expect(failures).toHaveLength(entrypoints.length);
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(SubscriptionRouteRequiresRuntime);
    expect(failure).toMatchObject({ account: "claude", retryable: false });
  }
  expect(touched).toEqual([]);
});
