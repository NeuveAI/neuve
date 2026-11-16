// Why: research reviews run at high effort while the owner's stay at medium (10.126). The effort
// comes from a settings file, so a settings file without it must freeze exactly the route it froze
// before (the owner's run keys stay put), one with it must reach both ways a route is named, and a
// run at another effort must never share a stored stage with one at medium.
import { expect, test } from "bun:test";
import { Option } from "effect";
import { Computations } from "@neuve/records-core";
import { defaultConfig, runKeyFor } from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { namedRoute, settingsRoute } from "../src/request.ts";
import { OPUS_ROUTE, SOL_ROUTE, type RouteConfig } from "../src/route.ts";
import { Settings } from "../src/settings.ts";

const settings = (review?: unknown) =>
  Option.some(
    Settings.parse({ version: 1, ...(review === undefined ? {} : { review }) }),
  );

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

const stageKey = (route: RouteConfig) =>
  Computations.computationKey(
    agentStageSpec(
      defaultConfig(undefined, route),
      { stage: "find", turnLimit: 25, agent: "investigate.p1" },
      {
        op: "harness.investigate",
        opVersion: 7,
        inputs: { plan: "computation:p" },
      },
    ),
  ).key;

test("without an effort setting, the frozen route is the route's own", () => {
  expect(settingsRoute(Option.none())).toEqual(OPUS_ROUTE);
  expect(settingsRoute(settings({ route: "openai" }))).toEqual(SOL_ROUTE);
  expect(namedRoute("openai", settings())).toEqual(SOL_ROUTE);
  expect(
    runKeyFor(
      range,
      defaultConfig(undefined, settingsRoute(settings({ route: "openai" }))),
    ),
  ).toBe(runKeyFor(range, defaultConfig(undefined, SOL_ROUTE)));
});

test("an effort setting reaches the settings' route and a named one, and leaves the routes alone", () => {
  const high = settings({ route: "openai", effort: "high" });
  expect(settingsRoute(high)).toEqual({ ...SOL_ROUTE, effort: "high" });
  expect(namedRoute("anthropic", high)).toEqual({
    ...OPUS_ROUTE,
    effort: "high",
  });
  // An effort alone keeps the default route.
  expect(settingsRoute(settings({ effort: "low" }))).toEqual({
    ...OPUS_ROUTE,
    effort: "low",
  });
  expect(SOL_ROUTE.effort).toBe("medium");
  expect(OPUS_ROUTE.effort).toBe("medium");
});

test("an effort the routes do not take is refused", () => {
  expect(() => settings({ effort: "max" })).toThrow();
  expect(() => settings({ effort: "high", reasoning: "high" })).toThrow();
});

test("runs at two efforts share neither the run key nor an agent stage's key", () => {
  const medium = SOL_ROUTE;
  const high = settingsRoute(settings({ route: "openai", effort: "high" }));
  expect(runKeyFor(range, defaultConfig(undefined, high))).not.toBe(
    runKeyFor(range, defaultConfig(undefined, medium)),
  );
  expect(stageKey(high)).not.toBe(stageKey(medium));
  expect(
    stageKey(settingsRoute(settings({ route: "openai", effort: "medium" }))),
  ).toBe(stageKey(medium));
});
