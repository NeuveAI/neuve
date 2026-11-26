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

/**
 * The keys at a248f77a, before steps had their own effort, computed there with the same steps by
 * `agentStageSpec` and `runKeyFor` over `defaultConfig(undefined, OPUS_ROUTE | SOL_ROUTE)`.
 */
const GOLDEN = {
  anthropic: {
    // Pipeline 12 run identity is historical; unchanged step keys remain reusable.
    run: "720ce74fe4364ec4914804655139c11e65160513ebaa872f5e53d09c04721d1c",
    frame: "a4ed3130b681459cf3b8af39281ba57e70e24b2f0e37185ed01308161d421a76",
    map: "568c94787aecd205f69e4857b1a505f5ecce3a68d22b2c4a77cecada846bd581",
    find: "e0d6a281a137ecb101720e00379548695ebd96a4fc8fc8868104902ae00db89c",
    verify: "d45e28934f461f54dc56d9cf1f2b6309bb1a8254c1cd29022b5d3aa62b824d04",
  },
  openai: {
    // Re-pinned (round 25): the pipeline version moved from 11 to 12.
    run: "c27221fd3a490479b60e0a89bb6bd544f5ee23a30db748cbe28f0eb4f16d813e",
    frame: "a653de0ab20617dedfdb62e269b5592b8f1f6b0a140458eea1d44a1a4cee99d1",
    map: "cf89c312cb1fd3e53345cb8810712f987faea187c57840fe23a166093f5c93ca",
    find: "c0f4f84c7806a6ec31ed05512c6a4597be4da2b40aca20c88cc880ce21e36c19",
    verify: "a957adfeefb23fc1d4a77a8913c3bd7ff38fc29fe84ee2f9f773043c2ec37d72",
  },
} as const;

const settings = (review?: unknown) =>
  Option.some(
    Settings.parse({ version: 1, ...(review === undefined ? {} : { review }) }),
  );

// Reason: nothing else pins a key's value, and a silent change rebuilds every stored stage.
test("the new ownership pipeline changes run identity but preserves unchanged effort-bound step keys", () => {
  for (const [route, previous] of [
    [OPUS_ROUTE, GOLDEN.anthropic],
    [SOL_ROUTE, GOLDEN.openai],
  ] as const) {
    const current = stageKeys(route);
    expect(current.run).not.toBe(previous.run);
    expect({ ...current, run: previous.run }).toEqual(previous);
  }
  expect(stageKeys(settingsRoute(Option.none()))).toEqual(
    stageKeys(OPUS_ROUTE),
  );
  expect(stageKeys(settingsRoute(settings({ route: "openai" })))).toEqual(
    stageKeys(SOL_ROUTE),
  );
});

// Reason: only what runs differently may key differently.
test("a step at another effort moves its own key and no other step's", () => {
  for (const [route, previous] of [
    [OPUS_ROUTE, GOLDEN.anthropic],
    [SOL_ROUTE, GOLDEN.openai],
  ] as const) {
    const golden = { ...previous, run: stageKeys(route).run };
    const name = route.provider;
    // From the route's per-kind efforts.
    const fromMap = stageKeys(
      routeByName(name, undefined, undefined, { map: "high" }),
    );
    expect(fromMap.map).not.toBe(golden.map);
    expect([fromMap.frame, fromMap.find, fromMap.verify]).toEqual([
      golden.frame,
      golden.find,
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
  ).toBe(stageKeys(OPUS_ROUTE).run);

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

// Raw settings/frozen routes remain readable, but obsolete find-only effort is not new work.
test("new route/settings admission ignores find effort without changing live effort controls", () => {
  const base = stageKeys(OPUS_ROUTE);
  expect(
    stageKeys(settingsRoute(settings({ stepEffort: { find: "high" } }))),
  ).toEqual(base);
  expect(
    stageKeys(routeByName("anthropic", undefined, undefined, { find: "high" })),
  ).toEqual(base);
  const mixed = settingsRoute(
    settings({ stepEffort: { find: "high", verify: "high" } }),
  );
  expect(mixed.stepEffort).toEqual({ verify: "high" });
  expect(stageKeys(mixed)).toEqual(
    stageKeys(
      routeByName("anthropic", undefined, undefined, { verify: "high" }),
    ),
  );
});
