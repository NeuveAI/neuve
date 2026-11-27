// Why (NEU-148, effort per reading step and effort by risk): every reading step now sets its own
// effort on its spec, and the plan can be packed by risk class. Turning neither on must not move a
// stored reading's key (else every stored reading is read again) nor the plan's bytes, and when the
// split is asked for it must give groups of one class each, with the efforts the rule names.
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { Computations } from "@neuve/records-core";
import { defaultConfig, type PipelineConfig } from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { erased, type AgentStep } from "../src/pi/stages/agent.ts";
import { KindParams } from "../src/pi/stages/run.ts";
import {
  claimStepInput,
  readingStepInput,
  withStepEffort,
  type ReadingTaskInput,
} from "../src/pi/stages/reading-task.ts";
import { claimVerifyStep } from "../src/readings/claims.ts";
import { planSpec, readingTaskInputs } from "../src/readings/collect.ts";
import {
  READING_EFFORT,
  readingCallEffort,
  readingEfforts,
  readingStepEffort,
  type ReadingStepKind,
} from "../src/readings/effort.ts";
import { planReadings, type ReadingPlan } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  READING_STORED_VERSION,
  assessStep,
  laneReviewStep,
} from "../src/readings/steps.ts";
import {
  OPUS_ROUTE,
  SOL_ROUTE,
  routeAtEffort,
  stepEffortOf,
  type AnyRouteConfig,
  type RouteEffort,
} from "../src/route.ts";
import { mixedRange, riskRange } from "./fixtures/readings.ts";

// The stage key now covers the context ceiling.
// These pins key the parent commit's step inputs for the mixed range's first group.
const PARENT_KEYS = {
  opus: {
    assess: "5371c8a75fea47eb0c4e1f59dded934ecf3d3ad4f7955e5dc36196c8196fae2c",
    laneReview:
      "57e99b27ca024f88c7e909d1d805a109dbd6bd26a5d93c5bb1292d05a9293798",
    claim: "cc62282c9cd2ff3e24d363b97f3264338db19b227b695a2a5ca14d41c709c120",
  },
  sol: {
    assess: "ffe4413a6fe07f1c9893f3a8f37e3dfd498722385745aad4e688f9a517dd42c3",
    laneReview:
      "87db4370e504eb4078b92c1db7442eebac9510ffe995589583011723d4ca9a90",
    claim: "dcb58168ba271b5423012eeca0f5339162074bce78d96a063c0371fe2f60a6d3",
  },
};

/**
 * The sha256 of the parent commit's plans' JSON for these fixtures, computed the same way. Round 6
 * moved the plan's recipe and added each section's `symbolRemoved`; with the recipe set back and the
 * field left out, the bytes are these.
 */
const PARENT_PLANS = {
  risk: "4905bd2c29331b47e3270938d31bed4d9162e23ece8010b6d1af1cfa8b172cfd",
  riskOnePerGroup:
    "875df37c429894d572cb910551ed80c95125bc331288550189c7d1698c439342",
  mixed: "3a53227b9196df98ae9743731d07f4ca2253e2feceef1b496aa530fbd6a232e9",
};

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A plan's bytes with the recipe before round 6. */
const before6 = (plan: ReadingPlan) =>
  sha({
    ...plan,
    recipe: "neuve-reading-v3",
    // Round 6c added each section's `symbolRemoved`, and 6d `removedAttributed` and `removedHeads`;
    // without them the bytes are the parent's.
    sections: plan.sections.map(
      ({
        symbolRemoved: _s,
        removedAttributed: _a,
        removedHeads: _h,
        ...rest
      }) => rest,
    ),
    unread: plan.unread.map(
      ({
        symbolRemoved: _s,
        removedAttributed: _a,
        removedHeads: _h,
        ...rest
      }) => rest,
    ),
  });

const mixed = mixedRange();
const mixedHunks = new Map(mixed.hunks.map((hunk) => [hunk.hunkId, hunk]));
const mixedPlan = planReadings({
  hunks: mixed.hunks,
  structures: mixed.structures,
  excluded: mixed.excluded,
});

const KEYS = {
  manifestKey: "manifest-key",
  frameKey: "frame-key",
  mapKey: "map-key",
  cutoffAt: 1_000_000,
};

/**
 * The first group's Assess, Lane review and one claim check, each prepared from the step parameters
 * its reading task gives it (`readingStepInput`, `claimStepInput`) as `readingStep` prepares it: the
 * step, then the effort its parameters carry (`withStepEffort`).
 */
const stepsOf = (tasks: ReadonlyArray<{ input: ReadingTaskInput }>) => {
  const group = mixedPlan.groups[0]!.id;
  const of = (kind: ReadingTaskInput["kind"]) =>
    tasks.find((t) => t.input.kind === kind && t.input.group === group)!.input;
  const assessParams = readingStepInput(of("assess"), "read", undefined);
  const reviewInput = of("lane-review");
  const reviewParams = readingStepInput(reviewInput, "read", {
    frame: "frame-key",
    map: "map-key",
  });
  const claimParams = claimStepInput(reviewInput, {
    key: "c".repeat(64),
    answer: "answer-key",
  });
  // Every one is what its kind's parameters accept, as run.ts reads them.
  const effort = (input: { kind: string; params: unknown }) =>
    KindParams[input.kind as "assess" | "lane-review" | "verify-claim"].parse(
      input.params,
    ).effort;
  const section = mixedPlan.groups[0]!.keys[0]!;
  return {
    assess: withStepEffort(
      erased(
        assessStep({
          stage: "verify",
          reading: renderReading(mixedPlan, group, {
            for: "assess",
            hunks: mixedHunks,
            structures: mixed.structures,
          }),
        }),
      ),
      effort(assessParams),
    ),
    laneReview: withStepEffort(
      erased(
        laneReviewStep({
          stage: "verify",
          reading: renderReading(mixedPlan, group, {
            for: "lane-review",
            hunks: mixedHunks,
            structures: mixed.structures,
          }),
          goal: { goal: "Let callers count parsed items.", doneWhen: [] },
          tools: [],
          keys: { frame: "frame-key", manifest: "manifest-key" },
        }),
      ),
      effort(reviewParams),
    ),
    claim: withStepEffort(
      erased(
        claimVerifyStep({
          key: "c".repeat(64),
          section,
          comment: {
            path: "src/parse.ts",
            side: "new",
            startLine: 2,
            endLine: 2,
            text: "The count is off by one.",
            fails: "Counting skips the last item.",
          },
          reading: renderReading(mixedPlan, group, {
            for: "lane-review",
            hunks: mixedHunks,
            structures: mixed.structures,
            only: [section],
          }),
          turnLimit: 1,
        }),
      ),
      effort(claimParams),
    ),
  };
};

const fullKeyOf = (
  config: PipelineConfig,
  step: Pick<AgentStep<unknown, unknown>, "spec" | "op" | "opVersion">,
  inputs: Record<string, unknown>,
) =>
  Computations.computationKey(
    agentStageSpec(config, step.spec, {
      op: step.op,
      opVersion: step.opVersion,
      inputs,
    }),
  ).key;

/**
 * The key without what the step is offered (`offered`, the readers' round 15): every parent key
 * below predates that input, which moved every Assess, Lane review and claim-check key on purpose
 * and nothing else, so the comparisons with the parents are made with it set back.
 */
const keyOf = (
  config: PipelineConfig,
  step: Pick<AgentStep<unknown, unknown>, "spec" | "op" | "opVersion">,
  inputs: Record<string, unknown>,
) => {
  const { offered: _offered, ...rest } = inputs;
  return fullKeyOf(config, step, rest);
};

/**
 * The row-reading round (a56671eb: each done-when row also gives its reading) moved the Lane review's
 * prompt version by two (12 to 14, past the scope-and-tests variant's 13) and its answer version from
 * 4 to 6 (past 5) on purpose, so every Lane review runs once again; it moved nothing else of these
 * keys, and no Assess or claim-check key. The comparisons with the parents set it back.
 */
const beforeRowReading = <
  S extends { readonly opVersion: number },
  I extends Record<string, unknown>,
>(
  kind: "assess" | "laneReview",
  step: S,
  inputs: I,
): readonly [S, I] =>
  kind === "laneReview"
    ? [
        { ...step, opVersion: step.opVersion - 2 },
        { ...inputs, answer: 4 },
      ]
    : [step, inputs];

/** The step's inputs without the stored form's version: the parent commit's inputs. */
const parentInputs = (inputs: Record<string, unknown>) => {
  const { stored: _stored, ...rest } = inputs;
  return rest;
};

// Reason: turning nothing on must not cold-rebuild every stored reading. The effort round's one key
// move was the stored form's version on Assess and Lane review; round 6 then moved their recipe and
// prompt versions on purpose (the caller and test rows), and the claim check shown no evidence keeps
// its key.
test("with default effort settings, the claim check reuses its key and the changed reading inputs move their keys", () => {
  for (const [name, route] of [
    ["opus", OPUS_ROUTE],
    ["sol", SOL_ROUTE],
  ] as const) {
    const config = defaultConfig(undefined, route);
    const tasks = readingTaskInputs(
      mixedPlan,
      "plan-key",
      KEYS,
      config.route,
      undefined,
    );
    const steps = stepsOf(tasks);
    // Every reading sets its kind's effort, the route's here; the claim check sets none.
    expect(tasks.map(({ input }) => [input.effort, input.claimEffort])).toEqual(
      mixedPlan.groups.flatMap(() => [
        [route.effort, undefined],
        [route.effort, undefined],
      ]),
    );
    expect([
      steps.assess.spec.effort,
      steps.laneReview.spec.effort,
      steps.claim.spec.effort,
    ]).toEqual([route.effort, route.effort, undefined]);
    const parent = PARENT_KEYS[name];
    for (const kind of ["assess", "laneReview"] as const) {
      const step = steps[kind];
      expect(step.inputs["stored"]).toBe(READING_STORED_VERSION);
      // Rounds 6, 7, 10 and the readers' rounds 9 and 13 moved the recipe and the prompt version, and
      // nothing else: with those two set back (and the stored form's version left out, as above),
      // every other step input, the task text's hash included, is the parent's.
      expect(step.inputs["recipe"]).toBe("neuve-reading-v10");
      expect(
        keyOf(
          config,
          // Rounds 6, 6e, 7, 7d and 10 each moved the prompt version by one; round 9 by two, past
          // the scope-and-tests variants' numbers; the row-reading round the Lane review's by two
          // more, and its answer version (`beforeRowReading`).
          ...beforeRowReading(
            kind,
            { ...step, opVersion: step.opVersion - 7 },
            { ...parentInputs(step.inputs), recipe: "neuve-reading-v3" },
          ),
        ),
      ).toBe(parent[kind]);
      expect(keyOf(config, step, parentInputs(step.inputs))).not.toBe(
        parent[kind],
      );
      expect(keyOf(config, step, step.inputs)).not.toBe(parent[kind]);
    }
    expect("stored" in steps.claim.inputs).toBe(false);
    expect(keyOf(config, steps.claim, steps.claim.inputs)).toBe(parent.claim);
    // What each step is offered moves all three keys from their pins.
    for (const kind of ["assess", "laneReview", "claim"] as const)
      expect(fullKeyOf(config, steps[kind], steps[kind].inputs)).not.toBe(
        parent[kind],
      );
  }
});

// Reason: a step at another effort must key apart, and only that step.
test("an Assess at its kind's own step effort, and effort by risk's levels, key apart only the steps whose effort moved", () => {
  const route = { ...SOL_ROUTE, stepEffort: { assess: "high" } } as const;
  const config = defaultConfig(undefined, route);
  const plain = stepsOf(
    readingTaskInputs(mixedPlan, "plan-key", KEYS, SOL_ROUTE, undefined),
  );
  const steps = stepsOf(
    readingTaskInputs(mixedPlan, "plan-key", KEYS, route, undefined),
  );
  expect(steps.assess.spec.effort).toBe("high");
  expect(keyOf(config, steps.assess, steps.assess.inputs)).not.toBe(
    keyOf(
      defaultConfig(undefined, SOL_ROUTE),
      plain.assess,
      plain.assess.inputs,
    ),
  );
  // The step's key is the one a step setting no effort has on a plain route at high: only the
  // effort it runs at counts.
  const { effort: _effort, ...unset } = plain.assess.spec;
  expect(keyOf(config, steps.assess, steps.assess.inputs)).toBe(
    keyOf(
      defaultConfig(undefined, routeAtEffort(SOL_ROUTE, "high")),
      { ...plain.assess, spec: unset },
      plain.assess.inputs,
    ),
  );
  for (const kind of ["laneReview", "claim"] as const)
    expect(keyOf(config, steps[kind], steps[kind].inputs)).toBe(
      keyOf(
        defaultConfig(undefined, SOL_ROUTE),
        plain[kind],
        plain[kind].inputs,
      ),
    );

  // By risk, on a medium route: Assess at medium keys as before, the claim check at high apart.
  const byRisk = readingEfforts(mixedPlan, mixedHunks);
  const risky = stepsOf(
    readingTaskInputs(mixedPlan, "plan-key", KEYS, SOL_ROUTE, byRisk),
  );
  const sol = defaultConfig(undefined, SOL_ROUTE);
  expect(risky.assess.spec.effort).toBe("medium");
  expect(keyOf(sol, risky.assess, risky.assess.inputs)).toBe(
    keyOf(sol, plain.assess, plain.assess.inputs),
  );
  expect(risky.claim.spec.effort).toBe("high");
  expect(keyOf(sol, risky.claim, risky.claim.inputs)).not.toBe(
    keyOf(sol, plain.claim, plain.claim.inputs),
  );
  expect(stepEffortOf(sol.route, "verify", risky.claim.spec.effort)).toBe(
    "high",
  );
});

/** The step efforts a review sets, by the name the tables below use. */
const ENTRIES = {
  none: undefined,
  assess: { assess: "high" },
  both: { assess: "high", "lane-review": "high" },
} as const;
const routeOf = (
  base: AnyRouteConfig,
  effort: RouteEffort,
  entries: keyof typeof ENTRIES,
): AnyRouteConfig => ({
  ...base,
  effort,
  ...(ENTRIES[entries] === undefined ? {} : { stepEffort: ENTRIES[entries] }),
});

// Reason: a default must never override what a person set, and must never raise a review above its
// own route.
test("without effort by risk, a reading runs at its kind's entry, else at the lower of the route's effort and medium; a claim check sets none and runs at its stage's", () => {
  expect(READING_EFFORT).toBe("medium");
  // [route effort, entries] -> [Assess, Lane review]; the claim check sets none and runs at the
  // route's, as no `verify` entry is named here.
  const table: ReadonlyArray<
    readonly [RouteEffort, keyof typeof ENTRIES, RouteEffort, RouteEffort]
  > = [
    ["high", "none", "medium", "medium"],
    ["high", "assess", "high", "medium"],
    ["high", "both", "high", "high"],
    ["medium", "none", "medium", "medium"],
    ["medium", "assess", "high", "medium"],
    ["medium", "both", "high", "high"],
    ["low", "none", "low", "low"],
    ["low", "assess", "high", "low"],
    ["low", "both", "high", "high"],
  ];
  const group = mixedPlan.groups[0]!.id;
  for (const base of [OPUS_ROUTE, SOL_ROUTE])
    for (const [effort, entries, assess, laneReview] of table) {
      const route = routeOf(base, effort, entries);
      const of = (kind: ReadingStepKind) => [
        readingStepEffort(route, undefined, kind, group),
        readingCallEffort(route, undefined, kind, group),
      ];
      expect([of("assess"), of("lane-review"), of("verify-claim")]).toEqual([
        [assess, assess],
        [laneReview, laneReview],
        [undefined, effort],
      ]);
      // What `prepare` lists carries the same, for every group.
      expect(
        readingTaskInputs(mixedPlan, "plan-key", KEYS, route, undefined).map(
          ({ input }) => [input.kind, input.effort, input.claimEffort],
        ),
      ).toEqual(
        mixedPlan.groups.flatMap(() => [
          ["assess", assess, undefined],
          ["lane-review", laneReview, undefined],
        ]),
      );
    }
  // A `verify` entry is what a claim check runs at; it still sets none of its own.
  const verify = {
    ...SOL_ROUTE,
    effort: "high",
    stepEffort: { verify: "low" },
  } as const;
  expect(readingStepEffort(verify, undefined, "verify-claim", group)).toBe(
    undefined,
  );
  expect(readingCallEffort(verify, undefined, "verify-claim", group)).toBe(
    "low",
  );
  // By risk, the fixed levels stand on every route, whatever the entries say.
  const byRisk = readingEfforts(mixedPlan, mixedHunks);
  for (const effort of ["low", "medium", "high"] as const)
    for (const entries of ["none", "assess", "both"] as const) {
      const route = routeOf(SOL_ROUTE, effort, entries);
      expect(
        mixedPlan.groups.map((g) => [
          readingStepEffort(route, byRisk, "assess", g.id),
          readingStepEffort(route, byRisk, "lane-review", g.id),
          readingStepEffort(route, byRisk, "verify-claim", g.id),
        ]),
      ).toEqual(
        mixedPlan.groups.map((g) => [
          "medium",
          byRisk.groups.get(g.id)!.laneReview,
          "high",
        ]),
      );
    }
});

/**
 * The first group's Assess, Lane review and claim-check keys for every route the tables name, by
 * risk and plain, in the order the parent commit's were computed. With `before9`, Assess and Lane
 * review are keyed with the readers' round 9 moves set back: its reading recipe (v9 from v8) and
 * its prompt versions (each by two, past the scope-and-tests variants' numbers). That round moved
 * those two and nothing else of these keys; the claim check, shown no evidence, it did not move.
 * Round 17 moved their stored version (from 2: the producer is stored with the output), so that
 * is set back too.
 */
const keyTable = (before9 = false) => {
  const keyed = (
    config: PipelineConfig,
    step: Pick<
      AgentStep<unknown, unknown>,
      "spec" | "op" | "opVersion" | "inputs"
    >,
    kind: "assess" | "laneReview",
  ) =>
    before9
      ? keyOf(
          config,
          // The row-reading round set back too (`beforeRowReading`).
          ...beforeRowReading(
            kind,
            { ...step, opVersion: step.opVersion - 2 },
            { ...step.inputs, recipe: "neuve-reading-v8", stored: 2 },
          ),
        )
      : keyOf(config, step, step.inputs);
  const out: Record<
    string,
    { assess: string; laneReview: string; claim: string }
  > = {};
  for (const [name, base] of [
    ["opus", OPUS_ROUTE],
    ["sol", SOL_ROUTE],
  ] as const)
    for (const effort of ["low", "medium", "high"] as const)
      for (const entries of ["none", "assess", "both"] as const)
        for (const byRisk of [false, true]) {
          const config = defaultConfig(
            undefined,
            routeOf(base, effort, entries),
          );
          const steps = stepsOf(
            readingTaskInputs(
              mixedPlan,
              "plan-key",
              KEYS,
              config.route,
              byRisk ? readingEfforts(mixedPlan, mixedHunks) : undefined,
            ),
          );
          out[`${name}.${effort}.${entries}.${byRisk ? "by-risk" : "plain"}`] =
            {
              assess: keyed(config, steps.assess, "assess"),
              laneReview: keyed(config, steps.laneReview, "laneReview"),
              claim: keyOf(config, steps.claim, steps.claim.inputs),
            };
        }
  return out;
};

// The parent commit's effort table with the current stage key, and the entries changed by the
// medium default. The table pin is the sha256 of its JSON.
const PARENT_TABLE =
  "8b8fb9ba8880e1c923595277975050832a6f69f480a8f207596d168ca83cda91";
const PARENT_MOVED = {
  "opus.high.none.plain": {
    assess: "fe53e827ba34b761a63ed2ddefadb21709359ad5b8dac2f30c620187e804a8fc",
    laneReview:
      "04e54a4ed18728f7aa5070e70536e07115e7798757647f19ed1b4a990d0d8646",
  },
  "opus.high.assess.plain": {
    laneReview:
      "04e54a4ed18728f7aa5070e70536e07115e7798757647f19ed1b4a990d0d8646",
  },
  "sol.high.none.plain": {
    assess: "6f643b3956107f369976be24cbfb7bbb935656bad632702e2a55aba3849a2243",
    laneReview:
      "ef486b2814b471e19f11d5e88c5eec1d2f6ead759efb04748ba24ae4eba8d4c8",
  },
  "sol.high.assess.plain": {
    laneReview:
      "ef486b2814b471e19f11d5e88c5eec1d2f6ead759efb04748ba24ae4eba8d4c8",
  },
} as const;

// Reason: stored answers at high must not be served for a medium reading, or the reverse; and only
// the readings whose effort moved may key apart.
test("on a high route, the medium default moves only the keys of readings whose effort changes", () => {
  // The parent predates the readers' round 9, which moved every Assess and Lane review key on
  // purpose (each row says what its line shows) and no claim check's: the comparisons with the
  // parent below are made with that round's moves set back.
  const now = keyTable();
  const table = keyTable(true);
  for (const [at, keys] of Object.entries(now)) {
    expect(keys.assess).not.toBe(table[at]!.assess);
    expect(keys.laneReview).not.toBe(table[at]!.laneReview);
    expect(keys.claim).toBe(table[at]!.claim);
  }
  for (const [at, moved] of Object.entries(PARENT_MOVED)) {
    const medium = table[at.replace(".high.", ".medium.")]!;
    for (const [kind, parent] of Object.entries(moved) as Array<
      ["assess" | "laneReview", string]
    >) {
      expect(table[at]![kind]).not.toBe(parent);
      // The effort it runs at is all that keys it: a medium reading on a medium route.
      expect(table[at]![kind]).toBe(medium[kind]);
    }
  }
  // An Assess whose entry names high keeps its key.
  expect(table["opus.high.assess.plain"]!.assess).toBe(
    PARENT_MOVED["opus.high.none.plain"].assess,
  );
  // Restoring the moved entries recovers the pinned table.
  const restored = Object.fromEntries(
    Object.entries(table).map(([at, keys]) => [
      at,
      { ...keys, ...(PARENT_MOVED as Record<string, object>)[at] },
    ]),
  );
  expect(sha(restored)).toBe(PARENT_TABLE);
});

const risk = riskRange();
const riskHunks = new Map(risk.hunks.map((hunk) => [hunk.hunkId, hunk]));
const riskPlan = (split: boolean): ReadingPlan =>
  planReadings({
    hunks: risk.hunks,
    structures: risk.structures,
    ...(split ? { split: "by-risk" as const } : {}),
  });

// Reason: the split must only exist when asked for.
test("off, the plan is the parent commit's byte for byte; on, a file's flagged and top-quarter sections are packed apart from its plain ones, each group of one class, at the rule's efforts", () => {
  // Off: the bytes of the parent commit's plans.
  expect(before6(riskPlan(false))).toBe(PARENT_PLANS.risk);
  expect(
    before6(
      planReadings({
        hunks: risk.hunks,
        structures: risk.structures,
        bounds: { maxItems: 1 },
      }),
    ),
  ).toBe(PARENT_PLANS.riskOnePerGroup);
  expect(before6(mixedPlan)).toBe(PARENT_PLANS.mixed);
  // Off, the riskRange is one group.
  expect(riskPlan(false).groups).toHaveLength(1);

  const on = riskPlan(true);
  const facts = readingEfforts(on, riskHunks);
  const sectionOf = new Map(on.sections.map((s) => [s.key, s]));
  const names = (keys: ReadonlyArray<string>) =>
    keys.map((k) => `${sectionOf.get(k)!.path}:${sectionOf.get(k)!.name}`);
  expect(on.sections).toEqual(riskPlan(false).sections);
  expect(on.groups.map((g) => names(g.keys))).toEqual([
    ["src/old.test.ts:drop", "src/strings.ts:f1", "src/strings.ts:f2"],
    ["f3", "f4", "f5", "f6", "f7", "f8", "f9"].map(
      (n) => `src/strings.ts:${n}`,
    ),
  ]);
  // The source file sits in both groups, under two IDs.
  expect(on.groups.every((g) => g.paths.includes("src/strings.ts"))).toBe(true);
  expect(new Set(on.groups.map((g) => g.id)).size).toBe(2);
  expect(on.groups.map((g) => facts.groups.get(g.id))).toEqual([
    { laneReview: "high", why: ["top-quarter", "removal", "public-surface"] },
    { laneReview: "medium", why: [] },
  ]);
  // A group's rank is still its highest section's.
  expect(on.groups.map((g) => g.rank)).toEqual([870_002, 750_002]);
  // The cut is floor(10 / 4) = 2 sections: f1 (the highest rank) and f2 (first of the tied body
  // edits in plan order).
  const factsOf = (path: string, name: string) =>
    facts.sections.get(
      on.sections.find((s) => s.path === path && s.name === name)!.key,
    );
  expect(factsOf("src/strings.ts", "f1")).toEqual({
    removal: false,
    publicSurface: true,
    topQuarter: true,
  });
  expect(factsOf("src/strings.ts", "f2")).toEqual({
    removal: false,
    publicSurface: false,
    topQuarter: true,
  });
  expect(factsOf("src/old.test.ts", "drop")).toEqual({
    removal: true,
    publicSurface: false,
    topQuarter: false,
  });
  expect(factsOf("src/strings.ts", "f5")).toEqual({
    removal: false,
    publicSurface: false,
    topQuarter: false,
  });
  expect(facts.counts).toEqual({
    sections: { high: 3, medium: 7 },
    groups: { high: 1, medium: 1 },
    groupsBy: { "top-quarter": 1, removal: 1, "public-surface": 1 },
    highSectionsBy: {
      "top-quarter+public-surface": 1,
      "top-quarter": 1,
      removal: 1,
    },
  });
  // Fixed levels whatever the route's effort: on a low route too.
  for (const route of [SOL_ROUTE, { ...OPUS_ROUTE, effort: "low" }] as const)
    expect(
      readingTaskInputs(
        on,
        "plan-key",
        KEYS,
        route as AnyRouteConfig,
        facts,
      ).map(({ input }) => [input.kind, input.effort, input.claimEffort]),
    ).toEqual([
      ["assess", "medium", undefined],
      ["lane-review", "high", "high"],
      ["assess", "medium", undefined],
      ["lane-review", "medium", "high"],
    ]);
  // The split plan keys apart; off, the plan key is as before.
  const spec = (effort?: "by-risk") =>
    Computations.computationKey(
      planSpec({
        manifestKey: "m",
        mapKey: "map",
        bounds: { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 },
        source: { sha256: "s" },
        ...(effort === undefined ? {} : { effort }),
      }),
    ).key;
  expect(spec("by-risk")).not.toBe(spec());
  expect(
    "effort" in
      (planSpec({
        manifestKey: "m",
        mapKey: "map",
        bounds: { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 },
        source: { sha256: "s" },
      }).inputs as Record<string, unknown>),
  ).toBe(false);
});
