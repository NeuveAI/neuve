// Why: each kind of review step may run at its own effort (12 November), as a substitution of the
// route's effort for that step only. A stage's stored key is what decides whether a later run reuses
// it, so a review with nothing set must keep every key it had, and only a step that runs at another
// effort may key apart.
import { expect, test } from "bun:test";
import { Option } from "effect";
import { Computations } from "@neuve/records-core";
import {
  PipelineConfig,
  defaultConfig,
  runKeyFor,
  turnLimitFor,
} from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { bindingRoute } from "../src/pi/bindings.ts";
import { settingsRoute } from "../src/request.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  routeAtEffort,
  routeByName,
  stepEffortOf,
  type RouteConfig,
  type RouteEffort,
} from "../src/route.ts";
import { Settings, reviewStepEffort } from "../src/settings.ts";

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

type Kind = "frame" | "map" | "find" | "verify";

/** One Frame, Map, find and Verify step, shaped as their builders shape them, with fixed inputs. */
const stageKeys = (
  route: RouteConfig,
  own: Partial<Record<Kind, RouteEffort>> = {},
) => {
  const config = defaultConfig(undefined, route);
  const key = (
    stage: Kind,
    spec: { readonly agent: string; readonly retries?: number },
    options: Parameters<typeof agentStageSpec>[2],
  ) =>
    Computations.computationKey(
      agentStageSpec(
        config,
        {
          stage,
          turnLimit: turnLimitFor(config, stage),
          ...spec,
          ...(own[stage] === undefined ? {} : { effort: own[stage] }),
        },
        options,
      ),
    ).key;
  return {
    run: runKeyFor(range, config),
    frame: key(
      "frame",
      { agent: "frame", retries: 1 },
      {
        op: "harness.frame",
        opVersion: 3,
        inputs: { basis: "basis", task: "c".repeat(64) },
      },
    ),
    map: key(
      "map",
      { agent: "map", retries: 1 },
      {
        op: "harness.map",
        opVersion: 2,
        inputs: { frame: "computation:frame", manifest: "d".repeat(64) },
      },
    ),
    find: key(
      "find",
      { agent: "find.correctness" },
      {
        op: "harness.find",
        opVersion: 4,
        inputs: {
          lens: "correctness",
          frame: "computation:frame",
          map: "computation:map",
          manifest: "computation:manifest",
          search: null,
        },
      },
    ),
    verify: key(
      "verify",
      { agent: "verify.correctness.1" },
      {
        op: "harness.verify",
        opVersion: 1,
        inputs: {
          find: "computation:find",
          finding: "f1",
          task: "e".repeat(64),
        },
      },
    ),
  };
};

const GOLDEN = {
  anthropic: {
    run: "720ce74fe4364ec4914804655139c11e65160513ebaa872f5e53d09c04721d1c",
    frame: "577ef7270610c9207ebbb4d427f6c95d5c9429a4dec3a2cf356c9997d9e134ec",
    map: "01b3a02fde601d3ad328d5d33803c1d8c8b521e2428d1dbbe6a4567d5ddfc7c8",
    find: "60ad493b1aaa10642a6ebb6ab821ae97990f988791e80386dd6ed4adfdedd543",
    verify: "298fdba36009b73e50a81181a84546c6797109279075d83189059e84c76c81db",
  },
  openai: {
    run: "94ddcd8de243036393bdf16cf8c2030dd275c5856e07eb9f9812146b3c5f7b25",
    frame: "34802747340ad98076cffce5984002ceae44891ed106eb305d66b53a0045d408",
    map: "62fb0c4f5ffe8cb0e661baffa9bedb2dc20e6ca6789a98151977f5ee5211bfdb",
    find: "5edb402160ef7d4bbc1219bc1e44e2e54f0ba60e782065032cb6d601aa520a17",
    verify: "3af1a2ca7833ff70702d0d11907ad5cb5c4ec31370a250cc9d2f9cfc80bef6db",
  },
} as const;

const settings = (review?: unknown) =>
  Option.some(
    Settings.parse({ version: 1, ...(review === undefined ? {} : { review }) }),
  );

// Reason: nothing else pins a key's value, and a silent change rebuilds every stored stage.
test.each([OPUS_ROUTE, SOL_ROUTE])(
  "pins the default $provider run and stage keys",
  (route) => {
    expect(stageKeys(route)).toEqual(GOLDEN[route.provider]);
    const selected =
      route.provider === "anthropic"
        ? settingsRoute(Option.none())
        : settingsRoute(settings({ route: "openai" }));
    expect(stageKeys(selected)).toEqual(GOLDEN[route.provider]);
  },
);

// Reason: only what runs differently may key differently.
test("a step at another effort moves its own key and no other step's", () => {
  for (const [route, golden] of [
    [OPUS_ROUTE, GOLDEN.anthropic],
    [SOL_ROUTE, GOLDEN.openai],
  ] as const) {
    const name = route.provider;
    // From the route's per-kind efforts.
    const fromMap = stageKeys(
      routeByName(name, undefined, undefined, { find: "high" }),
    );
    expect(fromMap.find).not.toBe(golden.find);
    expect([fromMap.frame, fromMap.map, fromMap.verify]).toEqual([
      golden.frame,
      golden.map,
      golden.verify,
    ]);
    // From the step's own effort.
    const fromStep = stageKeys(route, { verify: "high" });
    expect(fromStep.verify).not.toBe(golden.verify);
    expect(fromStep).toEqual({ ...golden, verify: fromStep.verify });
    // The same effort either way is the same stage.
    expect(
      stageKeys(routeByName(name, undefined, undefined, { verify: "high" }))
        .verify,
    ).toBe(fromStep.verify);
    // An effort equal to the route's, from the map or the step, keys every stage where it was.
    const same = stageKeys(
      routeByName(name, undefined, undefined, {
        frame: "medium",
        map: "medium",
        find: "medium",
        verify: "medium",
      }),
      { find: "medium" },
    );
    expect({ ...same, run: golden.run }).toEqual(golden);
  }
});

// Reason: two runs with different step efforts must never share a run key, and a default run must keep its own.
test("an absent or empty map freezes the route as before; a set map changes the run key", () => {
  expect(routeByName("anthropic")).toBe(OPUS_ROUTE);
  expect(routeByName("openai", undefined, undefined, {})).toBe(SOL_ROUTE);
  expect(settingsRoute(settings({ stepEffort: {} }))).toEqual(OPUS_ROUTE);
  expect("stepEffort" in settingsRoute(settings({ stepEffort: {} }))).toBe(
    false,
  );
  expect(
    runKeyFor(range, defaultConfig(undefined, settingsRoute(settings({})))),
  ).toBe(GOLDEN.anthropic.run);

  const high = settingsRoute(settings({ stepEffort: { assess: "high" } }));
  const low = settingsRoute(settings({ stepEffort: { assess: "low" } }));
  expect(high).toEqual({ ...OPUS_ROUTE, stepEffort: { assess: "high" } });
  const runOf = (route: RouteConfig) =>
    runKeyFor(range, defaultConfig(undefined, route));
  expect(runOf(high)).not.toBe(GOLDEN.anthropic.run);
  expect(runOf(high)).not.toBe(runOf(low));
  // The map travels inside the frozen route, so a stored configuration parses back with it.
  expect(PipelineConfig.parse(defaultConfig(undefined, high)).route).toEqual(
    high,
  );
});

// Reason: the readers lane resolves its steps' effort with these; the key and the wire must not disagree.
test("a step's effort is its own, else its kind's, else the route's, and only it is substituted", () => {
  const route = routeByName("openai", "low", undefined, {
    "lane-review": "high",
  });
  expect(stepEffortOf(route, "assess")).toBe("low");
  expect(stepEffortOf(route, "lane-review")).toBe("high");
  expect(stepEffortOf(route, "lane-review", "medium")).toBe("medium");
  expect(routeAtEffort(route, "low")).toBe(route);
  expect(routeAtEffort(route, "high")).toEqual({ ...route, effort: "high" });
  // The route a binding's provider is built with.
  expect(bindingRoute(route, {})).toBe(route);
  expect(bindingRoute(route, { effort: "low" })).toBe(route);
  expect(bindingRoute(OPUS_ROUTE, { effort: "high" })).toEqual({
    ...OPUS_ROUTE,
    effort: "high",
  });
});

// Reason: input handling at the boundary.
test("the setting refuses unknown kinds and levels, and reads as nothing when unset", () => {
  expect(() => settings({ stepEffort: { investigate: "high" } })).toThrow();
  expect(() => settings({ stepEffort: { find: "max" } })).toThrow();
  expect(() => settings({ stepEffort: "high" })).toThrow();
  expect(reviewStepEffort(Option.none())).toBeUndefined();
  expect(reviewStepEffort(settings())).toBeUndefined();
  expect(reviewStepEffort(settings({ effort: "high" }))).toBeUndefined();
  expect(
    reviewStepEffort(
      settings({ stepEffort: { frame: "low", assess: "high" } }),
    ),
  ).toEqual({ frame: "low", assess: "high" });
  // A frozen route refuses the same.
  expect(() =>
    PipelineConfig.parse({
      ...defaultConfig(),
      route: { ...OPUS_ROUTE, stepEffort: { investigate: "high" } },
    }),
  ).toThrow();
});
