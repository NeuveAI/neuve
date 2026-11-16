// Why: reasoning summaries are telemetry for reading runs, so a run that stores them must show the
// model exactly what a run without them shows it. Two things carry that, and neither is visible to
// the type checker: the replayed history must never carry a stored summary back to the model, and
// the request may differ only by the summary it asks for. A measured run must also be untouched: a
// settings file without the setting freezes the same route and the same keys, while a run with it
// keys its stages apart so a reading run never reuses, or is reused as, a measured run's stage.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { Option } from "effect";
import { Computations } from "@neuve/records-core";
import { defaultConfig, runKeyFor } from "../src/config.ts";
import type { ModelCaptureEvent } from "../src/pi/capture/types.ts";
import { createRouteModels } from "../src/pi/providers/agent-route-provider.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./pi/providers/fixture.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { namedRoute, settingsRoute } from "../src/request.ts";
import { OPUS_ROUTE, SOL_ROUTE, type RouteConfig } from "../src/route.ts";
import { Settings } from "../src/settings.ts";

const settings = (review?: unknown) =>
  Option.some(
    Settings.parse({ version: 1, ...(review === undefined ? {} : { review }) }),
  );

const scratch = mkdtempSync(join(tmpdir(), "reasoning-summaries-"));
const token = tokenCommand(scratch, "lease");
const endpoint = openEndpoint();
afterAll(() => {
  endpoint.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const route = (reasoningSummary?: "detailed") => ({
  ...SOL_ROUTE,
  effort: "high" as const,
  ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
});

// The native transcript stores the summary in text and in the provider's signed reasoning item.
const history = (summaries: boolean): Context => {
  const assistant = (id: string, text: string): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: SOL_ROUTE.model,
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "thinking",
        thinking: summaries ? text : "",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: `rs_${id}`,
          encrypted_content: `enc-${id}`,
          summary: summaries ? [{ type: "summary_text", text }] : [],
        }),
      },
      { type: "text", text: "Done." },
    ],
  });
  return {
    systemPrompt: "You are the test agent.",
    messages: [
      { role: "user", content: "Review this.", timestamp: 1 },
      assistant("1", "Checking the caller first."),
      { role: "user", content: "Check the error path.", timestamp: 1 },
      assistant("2", "The error path drops the cause."),
    ],
  };
};

const sentRequest = async (summaries: boolean) => {
  const captured: Array<ModelCaptureEvent> = [];
  const models = createRouteModels({
    credentialInspection: "ephemeral" as const,
    capture: (event) => captured.push(event),
    route: route(summaries ? "detailed" : undefined),
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    runId: "summary-proof",
    sessionAffinity: "summaries",
  });
  endpoint.respond(() =>
    sse([
      created("resp_summary"),
      ...messageItem(0, "msg_summary", "final_answer", "Done."),
      completed("resp_summary"),
    ]),
  );
  const result = await models.complete(
    models.getModel("openai", SOL_ROUTE.model)!,
    history(summaries),
  );
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
  expect(
    captured.filter((event) => event.type === "model.request"),
  ).toHaveLength(1);
  return endpoint.received.at(-1)!.body;
};

test("the native replayed input is byte-identical with and without stored summaries", async () => {
  const without = await sentRequest(false);
  const withSummaries = await sentRequest(true);
  expect(JSON.stringify(withSummaries["input"])).toBe(
    JSON.stringify(without["input"]),
  );
  expect(withSummaries["instructions"]).toBe(without["instructions"]);
  const reasoning = (
    withSummaries["input"] as Array<Record<string, unknown>>
  ).filter((item) => item["type"] === "reasoning");
  expect(reasoning).toEqual([
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
    { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "enc-2" },
  ]);
});

test("the native request differs only by the summary it asks for", async () => {
  const without = await sentRequest(false);
  const withSummaries = await sentRequest(true);
  expect(without["reasoning"]).toEqual({
    effort: "high",
    context: "all_turns",
  });
  expect(withSummaries["reasoning"]).toEqual({
    effort: "high",
    context: "all_turns",
    summary: "detailed",
  });
  const { reasoning: _a, ...restWithout } = without;
  const { reasoning: _b, ...restWith } = withSummaries;
  expect(JSON.stringify(restWith)).toBe(JSON.stringify(restWithout));
});

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};
const stageSpec = (route: RouteConfig) =>
  agentStageSpec(
    defaultConfig(undefined, route),
    { stage: "verify", turnLimit: 15, agent: "dispose.b1.u1" },
    {
      op: "harness.dispose",
      opVersion: 4,
      inputs: { unit: "computation:u" },
    },
  );
const stageKey = (route: RouteConfig) =>
  Computations.computationKey(stageSpec(route)).key;

test("without the setting a run freezes the same route and keys; with it, its stages key apart", () => {
  const off = settings({ route: "openai", effort: "high" });
  const on = settings({
    route: "openai",
    effort: "high",
    reasoningSummaries: true,
  });
  expect(settingsRoute(off)).toEqual({ ...SOL_ROUTE, effort: "high" });
  expect(
    settingsRoute(
      settings({ route: "openai", effort: "high", reasoningSummaries: false }),
    ),
  ).toEqual(settingsRoute(off));
  expect(settingsRoute(on)).toEqual({
    ...SOL_ROUTE,
    effort: "high",
    reasoningSummary: "detailed",
  });
  expect(stageKey(settingsRoute(off))).toBe(
    stageKey({ ...SOL_ROUTE, effort: "high" }),
  );
  expect(stageKey(settingsRoute(on))).not.toBe(stageKey(settingsRoute(off)));
  expect(
    runKeyFor(range, defaultConfig(undefined, settingsRoute(on))),
  ).not.toBe(runKeyFor(range, defaultConfig(undefined, settingsRoute(off))));
});

// The store refuses a spec its schema doesn't know, so a key that only hashes is not enough: a
// reading run's first stage failed there once.
test("the computation store accepts a stage spec with and without the setting", () => {
  for (const reasoningSummaries of [false, true]) {
    const spec = stageSpec(
      settingsRoute(
        settings({ route: "openai", effort: "high", reasoningSummaries }),
      ),
    );
    const parsed = Computations.ComputationSpec.safeParse(spec);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(spec);
  }
});

test("the setting leaves the Anthropic route alone", () => {
  expect(
    namedRoute("anthropic", settings({ reasoningSummaries: true })),
  ).toEqual(OPUS_ROUTE);
});
