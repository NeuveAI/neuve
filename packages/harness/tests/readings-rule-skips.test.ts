import { oneBatchPlanMap } from "./fixtures/readings.ts";
// Why: rule skips (decision 14.17) let a section a code rule decides go without a model reading.
// With the setting off, nothing may move: the plan, its key, the readings block and so the run key
// must be byte for byte what the code at the base this branch is merged onto gave, or every stored
// plan and run of a user who never turned it on would be read again under new keys. With it on,
// a decided section must still be accounted for: unread with its decision, in no group, and every
// owned row still in exactly one section, so nothing a rule decides goes silent. The pins below
// were computed by running the base's own `planReadings`, `planSpec` and `readingsConfig` on the
// same inputs, with `tools/sections-9-pins.ts` in the NEU-148 coordination folder (it unpacks the
// base's sources with `git archive` into a scratch folder and runs them); rerun it on a new base.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";

import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import {
  PipelineConfig,
  defaultConfig,
  type ReadingsConfig,
} from "../src/config.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  defaultManifestSettings,
  frontManifest,
  type ManifestHunk,
} from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { storedOutput } from "../src/pipeline.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { stageRunner } from "../src/pi/stages/services.ts";
import type { RunLogRecord } from "../src/run-log.ts";
import { planSpec, storePlan } from "../src/readings/collect.ts";
import {
  ReadingPlan,
  planReadings,
  type PlanSection,
} from "../src/readings/plan.ts";
import { readingsConfig, withRuleSkips } from "../src/request.ts";
import {
  RULE_SKIPS_RECIPE,
  SECTION_RULE_VERSIONS,
  rulesRunSpec,
  type RuleDecision,
} from "../src/section-rules.ts";
import { Settings } from "../src/settings.ts";
import { mixedRange } from "./fixtures/readings.ts";

/**
 * The base's values on the inputs below: the readers' head this merge is made onto, `859dac0e`
 * (the lift's recipe v10 and the gitlink's plan version 8, no rule skips), computed there with the
 * same calls as below. They were `a8d7927d`'s before those two moved the recipe and the plan key.
 */
const AT_BASE = {
  plan: "209a650e9e276e00b787e7dc40bd8d7f20bee81070f93ff6fdf5746d2fed00fc",
  planByRisk:
    "31577f7ca9bc4dc553c952175bfeb83de5ca5583016696c1210200e85b0daf77",
  planKey: "10b128be7ac2b98b994ded7aa107bdbe2c003984cda83c566f0156e5de36d280",
  planKeyByRisk:
    "db2bcfabef8e58ac089734f7d4c70c7d039b5482a2be005bb7167f3c64d9ee6a",
  config: {
    mode: "probe",
    bounds: { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 },
    recipe: "neuve-reading-v10+scope-and-tests",
    effort: "by-risk",
    scopeAndTests: true,
  },
} as const;

const BOUNDS = { maxFiles: 16, maxCharacters: 48_000, maxItems: 40 };
const SOURCE = { sha256: "s" };
const RULES_KEY = "c".repeat(64);

const planOf = (
  range: ReturnType<typeof mixedRange>,
  extra: Partial<Parameters<typeof planReadings>[0]> = {},
) =>
  planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
    ...extra,
  });

const keyOf = (spec: Computations.ComputationSpec) =>
  Computations.computationKey(spec).key;

const decision = (
  key: string,
  rule: RuleDecision["rule"] = "blank-rows-only",
): RuleDecision => ({
  rule,
  version: SECTION_RULE_VERSIONS[rule],
  judgement: `${key}.rule:${rule}`,
  statement: `${rule} held`,
  limit: null,
});

/** Every changed row a hunk's owned ranges hold, as `hunk side line`. */
const ownedRows = (hunks: ReadonlyArray<ManifestHunk>) =>
  hunks.flatMap((hunk) =>
    hunk.ownedRanges
      .filter((range) => range.lineCount > 0 && range.startLine > 0)
      .flatMap((range) =>
        Array.from(
          { length: range.lineCount },
          (_, at) => `${hunk.hunkId} ${range.side} ${range.startLine + at}`,
        ),
      ),
  );

const sectionRows = (section: PlanSection) =>
  section.owned.flatMap((range) =>
    Array.from(
      { length: range.endLine - range.startLine + 1 },
      (_, at) => `${range.hunkId} ${range.side} ${range.startLine + at}`,
    ),
  );

test("with no decided sections the plan is byte for byte the base's", () => {
  // Why: absent `decided` must be today's plan exactly; an empty map decides nothing either.
  const range = mixedRange();
  const bytes = (plan: ReadingPlan) => sha256Hex(JSON.stringify(plan));
  expect(bytes(planOf(range))).toBe(AT_BASE.plan);
  expect(bytes(planOf(range, { split: "by-risk" }))).toBe(AT_BASE.planByRisk);
  expect(bytes(planOf(range, { decided: new Map() }))).toBe(AT_BASE.plan);
  expect(JSON.stringify(planOf(range))).not.toContain("decidedBy");
});

test("the plan key includes Map and changes when it depends on rule judgements", () => {
  // A replay must find the same plan, and changing Map or the rules must plan again.
  const spec = (extra: Partial<Parameters<typeof planSpec>[0]> = {}) =>
    planSpec({
      manifestKey: "m",
      mapKey: "map",
      bounds: BOUNDS,
      source: SOURCE,
      ...extra,
    });
  expect(keyOf(spec())).toBe(AT_BASE.planKey);
  expect(keyOf(spec({ effort: "by-risk" }))).toBe(AT_BASE.planKeyByRisk);
  expect(keyOf(spec({ rules: undefined }))).toBe(AT_BASE.planKey);
  expect(keyOf(spec({ mapKey: "different-map" }))).not.toBe(AT_BASE.planKey);
  for (const name of ["rules", "ruleSkips", "rulesRetryable"])
    expect(name in (spec().inputs as Record<string, unknown>)).toBe(false);

  const on = spec({ rules: RULES_KEY });
  expect(on.inputs).toEqual({
    ...(spec().inputs as Record<string, unknown>),
    rules: `computation:${RULES_KEY}`,
    ruleSkips: RULE_SKIPS_RECIPE,
  });
  expect(keyOf(on)).not.toBe(AT_BASE.planKey);
});

test("the plan keys on the rules computation that ran: retryable outcomes with the same reasons but other gap blobs key apart, and one with no gaps keys as the stable rules do", () => {
  // Why: the decided set depends on which blobs went without tokens, so a plan built from one
  // retryable outcome must never be found for another with the same reasons on other blobs.
  const stable: Computations.ComputationSpec = {
    op: "harness.section-rules",
    opVersion: 1,
    inputs: { facts: "f" },
    config: { recipe: "r" },
  };
  const gap = (path: string, blob: string) =>
    rulesRunSpec(stable, [
      [path, `git-blob:${blob.repeat(40)}`, "graph-unavailable"],
    ]);
  const onA = gap("a.ts", "a");
  const onB = gap("b.ts", "b");
  expect(keyOf(onA)).not.toBe(keyOf(onB));
  expect(keyOf(onA)).not.toBe(keyOf(stable));
  expect(keyOf(rulesRunSpec(stable, []))).toBe(keyOf(stable));
  const planKey = (rules: string) =>
    keyOf(
      planSpec({
        manifestKey: "m",
        mapKey: "map",
        bounds: BOUNDS,
        source: SOURCE,
        rules,
      }),
    );
  expect(planKey(keyOf(onA))).not.toBe(planKey(keyOf(onB)));
  expect(planKey(keyOf(rulesRunSpec(stable, [])))).toBe(planKey(keyOf(stable)));
});

test("without the setting the readings block is the base's; with it the block carries ruleSkips and parses", () => {
  // Why: the block is frozen into the run's configuration, and so into its run key.
  const review = {
    sectionReadings: "probe",
    sectionReadingsEffort: "by-risk",
    sectionReadingsScopeAndTests: true,
  } as const;
  const block = (extra: Record<string, unknown> = {}) =>
    readingsConfig(
      Option.some(
        Settings.parse({ version: 1, review: { ...review, ...extra } }),
      ),
    );
  expect(block()).toEqual(AT_BASE.config);
  expect("ruleSkips" in block()!).toBe(false);
  expect(block({ sectionReadingsRuleSkips: false })).toEqual(AT_BASE.config);
  const on = block({ sectionReadingsRuleSkips: true });
  expect(on).toEqual({ ...AT_BASE.config, ruleSkips: true });
  expect(PipelineConfig.shape.readings.parse(on)).toEqual(on);
  // The setting turns no readings on: with the readings' off switch it freezes no block.
  expect(
    readingsConfig(
      Option.some(
        Settings.parse({
          version: 1,
          review: { sectionReadings: "off", sectionReadingsRuleSkips: true },
        }),
      ),
    ),
  ).toEqual({ ...readingsConfig(Option.none()), ruleSkips: true });
});

test("rule skips ride on whatever block a readings mode builds, never on a mode check", () => {
  // Why: the readers lane adds a publishing mode; it must carry the skip without an edit here.
  const other = {
    mode: "publish",
    bounds: BOUNDS,
    recipe: "any",
  } as unknown as ReadingsConfig;
  expect(withRuleSkips({ sectionReadingsRuleSkips: true }, other)).toEqual({
    ...other,
    ruleSkips: true,
  });
  expect(withRuleSkips({}, other)).toEqual(other);
  expect(withRuleSkips({ sectionReadingsRuleSkips: false }, other)).toEqual(
    other,
  );
});

test("decided sections are unread with their decision and in no group, and every owned row is still in exactly one section", () => {
  // Why: a skip must never make a row silent, and a reader must be told which rule decided it.
  const range = mixedRange();
  const before = planOf(range);
  // Two read sections and one excluded one: an excluded file stays excluded.
  const [first, second] = before.sections.filter((s) => s.characters > 0);
  const excluded = before.unread.find((s) => s.cause === "excluded")!;
  const decided = new Map([
    [first!.key, decision(first!.key)],
    [second!.key, decision(second!.key, "moved-unchanged")],
    [excluded.key, decision(excluded.key, "generated")],
  ]);
  const plan = planOf(range, { decided });
  expect(ReadingPlan.parse(plan)).toEqual(plan);

  const grouped = plan.groups.flatMap((group) => group.keys);
  for (const key of [first!.key, second!.key]) {
    expect(plan.sections.some((s) => s.key === key)).toBe(false);
    expect(grouped).not.toContain(key);
    const unread = plan.unread.find((s) => s.key === key)!;
    expect(unread.cause).toBe("rule-decided");
    expect(unread.decidedBy).toEqual(decided.get(key)!);
  }
  expect(plan.unread.find((s) => s.key === excluded.key)).toMatchObject({
    cause: "excluded",
  });
  // Only a rule-decided section has a decision; every other section is as it was.
  expect(
    plan.unread.filter((s) => s.decidedBy !== undefined).map((s) => s.key),
  ).toEqual(
    plan.unread.filter((s) => s.cause === "rule-decided").map((s) => s.key),
  );
  const strip = ({
    cause: _c,
    decidedBy: _d,
    ...rest
  }: Record<string, unknown>) => rest;
  const was = new Map(
    [...before.sections, ...before.unread].map((s) => [s.key, strip(s)]),
  );
  for (const section of [...plan.sections, ...plan.unread])
    expect(strip(section)).toEqual(was.get(section.key)!);
  expect(grouped.slice().sort()).toEqual(
    plan.sections.map((s) => s.key).sort(),
  );

  const counts = new Map<string, number>();
  for (const row of [...plan.sections, ...plan.unread].flatMap(sectionRows))
    counts.set(row, (counts.get(row) ?? 0) + 1);
  const owned = ownedRows(range.hunks);
  expect(owned.length).toBeGreaterThan(1_800);
  for (const row of owned) expect([row, counts.get(row)]).toEqual([row, 1]);
  expect([...counts.keys()].sort()).toEqual([...new Set(owned)].sort());
});

test("a plan section has a decision exactly when a rule decides it", () => {
  // Why: a stored plan with a decision on a section read for another cause, or a decided one with
  // none, would tell a reader something the plan did not do.
  const plan = planOf(mixedRange());
  const unread = plan.unread[0]!;
  const parse = (section: Record<string, unknown>) =>
    ReadingPlan.safeParse({ ...plan, unread: [section] }).success;
  expect(parse({ ...unread })).toBe(true);
  expect(parse({ ...unread, cause: "rule-decided" })).toBe(false);
  expect(parse({ ...unread, decidedBy: decision(unread.key) })).toBe(false);
  expect(
    parse({
      ...unread,
      cause: "rule-decided",
      decidedBy: decision(unread.key),
    }),
  ).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// `storePlan` with the setting on, in a real repository, against the real engine
// ---------------------------------------------------------------------------------------------

const directory = mkdtempSync(join(tmpdir(), "readings-rule-skips-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

const FUNCTIONS_BEFORE = `export function a() {
  return 1;
}

export function b() {
  return 2;
}
`;
/** One blank line more between the two functions: nothing else changes. */
const FUNCTIONS_AFTER = `export function a() {
  return 1;
}


export function b() {
  return 2;
}
`;

/** A repository whose one commit adds a blank line in one file and changes code in another. */
const repositoryOf = () => {
  const repository = join(directory, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const git = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-C", repository, ...args])
      .stdout.toString()
      .trim();
  const commit = (message: string) => {
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(repository, "src", "layout.ts"), FUNCTIONS_BEFORE);
  writeFileSync(
    join(repository, "src", "code.ts"),
    "export const c = () => 1;\n",
  );
  const base = commit("base");
  writeFileSync(join(repository, "src", "layout.ts"), FUNCTIONS_AFTER);
  writeFileSync(
    join(repository, "src", "code.ts"),
    "export const c = () => 2;\n",
  );
  const head = commit("change");
  return { repository, range: { baseOid: base, headOid: head } };
};

test.skipIf(graph.skip)(
  "with the setting on a decided section is planned unread; when the rules fail the plan is the one with the setting off, and the run log names the failure's tag once",
  async () => {
    // Why: a skip only saves work, so a failing rule computation must not cost the review its
    // readings (before 9b the plan failed and no section was read); it must fall back to reading
    // everything, under the plan key a run without the setting uses, and say so without the
    // failure's text. With the rules working, the decided section must not be read.
    graph.require();
    const { repository, range } = repositoryOf();
    const location = storeLocationIn(join(directory, "store"));
    const scope = await Effect.runPromise(Scope.make());
    const records = await Effect.runPromise(
      Layer.buildWithScope(
        Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(Store.layer(location, { create: true })),
          Layer.provideMerge(BunFileSystem.layer),
        ),
        scope,
      ),
    );
    await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
    const clients = Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(
          mcpClientsLayer({ status: "absent", path: "(none)" }),
          scope,
        ),
      ),
      McpClients,
    );
    const rows: Array<RunLogRecord> = [];
    const ctxWith = (readings: ReadingsConfig) => ({
      location,
      repository,
      runId: mintUlid(),
      runKey: "f".repeat(64),
      range: { baseRef: "main", ...range },
      cycleId: mintUlid(),
      config: { ...defaultConfig(), readings },
      log: {
        path: "(memory)",
        write: (row: RunLogRecord) => {
          rows.push(row);
        },
        read: () => rows,
      },
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    });
    const probe: ReadingsConfig = {
      mode: "probe",
      bounds: { ...DEFAULT_READING_BOUNDS },
      recipe: "r",
    };
    const off = ctxWith(probe);
    const on = ctxWith({ ...probe, ruleSkips: true });
    const run = stageRunner(off, clients);
    const manifest = await run(
      frontManifest(
        repository,
        range,
        defaultManifestSettings(1_000_000),
        source,
      ),
    );
    const planned = (ctx: typeof off) =>
      run(
        storePlan(ctx, {
          manifestKey: manifest.key,
          bounds: DEFAULT_READING_BOUNDS,
          map: oneBatchPlanMap(manifest),
          manifest: manifest.value,
        }),
      );
    const offKey = await planned(off);
    const offPlan = await run(storedOutput(off, offKey, ReadingPlan));
    expect(offPlan.unread).toEqual([]);

    // The forced failure: the attribute read cannot make its temporary directory, as a file
    // stands where the temporary root would be. The structures are stored already.
    const blocked = join(directory, "tmp-blocked");
    writeFileSync(blocked, "");
    const previous = process.env.TMPDIR;
    let failedKey: string;
    try {
      process.env.TMPDIR = join(blocked, "tmp");
      failedKey = await planned(on);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(failedKey).toBe(offKey);
    const failures = rows.filter((row) => row.type === "readings.rules");
    expect(failures).toEqual([
      { type: "readings.rules", failed: true, tag: "Error" },
    ]);

    // The rules working: the blank line's section is decided and not read, the code is read.
    const onKey = await planned(on);
    expect(onKey).not.toBe(offKey);
    const onPlan = await run(storedOutput(on, onKey, ReadingPlan));
    const decided = onPlan.unread.filter((s) => s.cause === "rule-decided");
    expect(decided.map((s) => s.path)).toEqual(["src/layout.ts"]);
    expect(["blank-rows-only", "whitespace-only"]).toContain(
      decided[0]!.decidedBy!.rule,
    );
    expect(onPlan.sections.map((s) => s.path)).toContain("src/code.ts");
    expect(onPlan.groups.flatMap((g) => g.keys)).not.toContain(decided[0]!.key);
    // Still one line: the failure is not logged again.
    expect(rows.filter((row) => row.type === "readings.rules")).toHaveLength(1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  },
  180_000,
);
