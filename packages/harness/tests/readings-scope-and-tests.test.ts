import { oneBatchPlanMap } from "./fixtures/readings.ts";
// Why (NEU-148 WP6, round 11): the content study found that the readings miss a change the goal
// never asked for, and a behaviour change no test exercises, because neither reading is asked (22 of
// 24 misses on the high passes). Both questions are built behind one setting, off by default
// (`review.sectionReadingsScopeAndTests`): Lane review is asked whether a section's change was asked
// for, and Assess which shown test rows exercise each requirement (`testedBy`). By the owner's ruling
// of 13 November a recognised test is a hint, never evidence: no code reads `testedBy` to decide. Each
// test names the result it pins and why.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import {
  PipelineConfig,
  defaultConfig,
  type ReadingsConfig,
} from "../src/config.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { laneOf, recordedLane } from "../src/lane-rule.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { agentStageSpec, storedOutput } from "../src/pipeline.ts";
import {
  erased,
  type AgentResult,
  type AgentStep,
} from "../src/pi/stages/agent.ts";
import { readingStep, structuresOf } from "../src/pi/stages/reading-task.ts";
import { stageRunner } from "../src/pi/stages/services.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { readingsConfig } from "../src/request.ts";
import { zeroUsage } from "../src/route.ts";
import type { Settings } from "../src/settings.ts";
import {
  AssessAnswer,
  AssessTestedAnswer,
  LaneReviewAnswer,
  LaneReviewScopedAnswer,
  assessExpand,
  assessIssues,
  assessRepair,
  laneReviewExpand,
  laneReviewIssues,
  laneReviewRepair,
} from "../src/readings/answers.ts";
import {
  planSpec,
  scopeAndTestsFields,
  storePlan,
} from "../src/readings/collect.ts";
import { decideSection } from "../src/readings/decide.ts";
import {
  READING_RECIPE,
  READING_RECIPE_SCOPE_AND_TESTS,
  ReadingPlan,
  planReadings,
} from "../src/readings/plan.ts";
import {
  ASSESS_TESTED_LINES,
  NOT_ASKED,
  assessSystem,
  assessTask,
  assessTestedSystem,
  laneReviewScopedSystem,
  laneReviewSystem,
  laneReviewTask,
} from "../src/readings/prompts.ts";
import {
  OTHER_FILES,
  SCOPE_LEGEND,
  UNCOVERED_LINE,
  renderReading,
  type ReadingKind,
} from "../src/readings/reading.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessStep,
  laneReviewStep,
  notAskedCount,
  testedByCounts,
} from "../src/readings/steps.ts";
import { noStructure, type BlobStructure } from "../src/sections.ts";
import { coverageOf } from "../src/proof-state.ts";
import {
  RECORDS,
  diff,
  inputFor,
  mixedRange,
  oidOf,
} from "./fixtures/readings.ts";

const directory = mkdtempSync(join(tmpdir(), "readings-scope-and-tests-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const mixed = mixedRange();
const plan = planReadings({
  hunks: mixed.hunks,
  structures: mixed.structures,
  excluded: mixed.excluded,
});
const hunks = new Map(mixed.hunks.map((hunk) => [hunk.hunkId, hunk]));
const sources = { hunks, structures: mixed.structures };
const groupOf = (path: string) =>
  plan.groups.find((group) => group.paths.includes(path))!;
/** The group that reads the parser, its test and the removal: three files, the test declared. */
const src = groupOf("src/parse.ts");

/** The done-when rows of the parser's file only: the group's other two files have none. */
const ROWS = new Map([
  [
    "src/parse.ts",
    [
      {
        row: "D1",
        text: "Counting returns the number of items.",
        requirements: [],
      },
    ],
  ],
]);
const GOAL = {
  goal: "Let callers count parsed items.",
  doneWhen: [{ id: "D1", text: "Counting returns the number of items." }],
};

const keyOf = (
  step: Pick<
    AgentStep<unknown, unknown>,
    "spec" | "op" | "opVersion" | "inputs"
  >,
  config: PipelineConfig = defaultConfig(),
) => Computations.computationKey(agentStageSpec(config, step.spec, step)).key;

const assessOf = (group: string, scopeAndTests?: boolean) =>
  erased(
    assessStep({
      stage: "verify",
      reading: renderReading(plan, group, {
        for: "assess",
        ...sources,
        ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
      }),
      ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
    }),
  );

const reviewOf = (group: string, scopeAndTests?: boolean) =>
  erased(
    laneReviewStep({
      stage: "verify",
      reading: renderReading(plan, group, {
        for: "lane-review",
        ...sources,
        rows: ROWS,
        ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
      }),
      goal: GOAL,
      tools: [],
      keys: { frame: "frame-a", manifest: "manifest-a" },
      ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
    }),
  );

const result = <O>(output: O): AgentResult<O> => ({
  agent: "reading.test",
  stage: "verify",
  status: "submitted",
  output,
  endedBy: "submit",
  turnsUsed: 1,
  turnLimit: 1,
  finalGeneration: false,
  usage: zeroUsage,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: 1,
});

const settingsOf = (review: NonNullable<Settings["review"]>) =>
  Option.some<Settings>({ version: 1, review });

/**
 * The readings block the parent commit froze for `sectionReadings: "probe"`, written out whole. The
 * readers' round 9 moved the readings' recipe (each row says what its line shows), and round 13
 * again (a caller row from an undecided file is marked), so the parent here is that round's block:
 * the setting still moves nothing of it.
 */
const PARENT_BLOCK: ReadingsConfig = {
  mode: "probe",
  bounds: { ...DEFAULT_READING_BOUNDS },
  recipe: "neuve-reading-v10",
};
const RANGE = {
  baseRef: "main",
  baseOid: "1".repeat(40),
  headOid: "2".repeat(40),
};

// ---------------------------------------------------------------------------------------------
// 1. Off: nothing moves
// ---------------------------------------------------------------------------------------------

// Reason: it is measured before any default moves.
test("every setting admits comprehensive readings while historical answers and plans still parse", () => {
  const current = readingsConfig(Option.none());
  for (const settings of [
    settingsOf({ sectionReadings: "off" }),
    settingsOf({ sectionReadingsScopeAndTests: false }),
    settingsOf({ sectionReadingsScopeAndTests: true }),
  ])
    expect(readingsConfig(settings)).toEqual(current);
  expect(current).toEqual({
    ...PARENT_BLOCK,
    recipe: READING_RECIPE_SCOPE_AND_TESTS,
    scopeAndTests: true,
  });

  // The plan takes no part of the setting: its key's inputs hold the parent's recipe either way.
  expect(
    (
      planSpec({
        manifestKey: "m",
        mapKey: "map",
        bounds: DEFAULT_READING_BOUNDS,
        source: { unavailable: "test" },
      }).inputs as Record<string, unknown>
    )["recipe"],
  ).toBe(READING_RECIPE);
  expect(READING_RECIPE).toBe("neuve-reading-v10");

  // Every group's readings and steps: false is absent, and absent is the parent's constants.
  for (const group of plan.groups) {
    for (const kind of [
      "assess",
      "lane-review",
    ] as const satisfies ReadonlyArray<ReadingKind>) {
      const render = (scopeAndTests?: boolean) =>
        kind === "assess"
          ? renderReading(plan, group.id, {
              for: "assess",
              ...sources,
              ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
            })
          : renderReading(plan, group.id, {
              for: "lane-review",
              ...sources,
              rows: ROWS,
              ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
            });
      expect(render(false).text).toBe(render().text);
      expect(render(false).listed).toEqual(render().listed);
      expect(render(true).text).not.toBe(render().text);
    }
    const assess = {
      absent: assessOf(group.id),
      off: assessOf(group.id, false),
    };
    const review = {
      absent: reviewOf(group.id),
      off: reviewOf(group.id, false),
    };
    for (const [step, parent] of [
      [
        assess,
        {
          // The readers' round 9 moved it from 11, past the variant's 12.
          opVersion: 13,
          answer: 6,
          system: assessSystem,
          schema: AssessAnswer,
        },
      ],
      [
        review,
        {
          // The readers' round 9 moved it from 10, past the variant's 11; round 30 from 12, past
          // the variant's 13, and the answer from 4, past the variant's 5 (each row's reading).
          opVersion: 14,
          answer: 6,
          system: laneReviewSystem,
          schema: LaneReviewAnswer,
        },
      ],
    ] as const) {
      for (const one of [step.absent, step.off]) {
        expect(one.opVersion).toBe(parent.opVersion);
        expect(one.inputs["recipe"]).toBe("neuve-reading-v10");
        expect(one.inputs["answer"]).toBe(parent.answer);
        expect(one.spec.system).toBe(parent.system);
        expect(one.spec.submit.schema).toBe(parent.schema);
      }
      expect(step.off.inputs).toEqual(step.absent.inputs);
      expect(step.off.spec.task).toBe(step.absent.spec.task);
      expect(keyOf(step.off)).toBe(keyOf(step.absent));
    }
  }
});

// The real range: a tiny repository read by the real engine, planned and stored as the readings
// store it, and each group's Assess step prepared by `readingStep` under the run's configuration.
const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

const repositoryOf = () => {
  const repository = join(directory, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "lib"), { recursive: true });
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
  writeFileSync(
    join(repository, "src", "count.ts"),
    "export function count(items: Array<string>) {\n  return items.length;\n}\n",
  );
  writeFileSync(
    join(repository, "lib", "label.ts"),
    "export const label = (n: number) => `${n} items`;\n",
  );
  const base = commit("base");
  writeFileSync(
    join(repository, "src", "count.ts"),
    "export function count(items: Array<string>) {\n  return items.filter(Boolean).length;\n}\n",
  );
  writeFileSync(
    join(repository, "lib", "label.ts"),
    'export const label = (n: number) => `${n} item${n === 1 ? "" : "s"}`;\n',
  );
  const head = commit("count only filled items");
  return { repository, range: { baseOid: base, headOid: head } };
};

// Reason: it is measured before any default moves; on a real range too.
test.skipIf(graph.skip)(
  "on a real range, the stored plan is the same with the setting on or off, and readingStep's Assess step with it off is the parent's step over the same reading",
  async () => {
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
    const ctxOf = (readings: ReadingsConfig) => ({
      location,
      repository,
      runId: mintUlid(),
      runKey: "f".repeat(64),
      range: { baseRef: "main", ...range },
      cycleId: mintUlid(),
      config: { ...defaultConfig(), readings },
      log: { path: "(memory)", write: () => {}, read: () => [] },
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    });
    const off = PARENT_BLOCK;
    const on = readingsConfig(Option.none());
    const ctx = { off: ctxOf(off), on: ctxOf(on) };
    const run = {
      off: stageRunner(ctx.off, clients),
      on: stageRunner(ctx.on, clients),
    };
    const manifest = await run.off(
      frontManifest(
        repository,
        range,
        defaultManifestSettings(1_000_000),
        source,
      ),
    );
    // One file per group, so each group has another file read separately.
    const bounds = { ...DEFAULT_READING_BOUNDS, maxFiles: 1 };
    const planKey = await run.off(
      storePlan(ctx.off, {
        manifestKey: manifest.key,
        bounds,
        map: oneBatchPlanMap(manifest),
        manifest: manifest.value,
      }),
    );
    // The plan does not take the setting: with it on, the same key.
    expect(
      await run.on(
        storePlan(ctx.on, {
          manifestKey: manifest.key,
          bounds,
          map: oneBatchPlanMap(manifest),
          manifest: manifest.value,
        }),
      ),
    ).toBe(planKey);
    const stored = await run.off(storedOutput(ctx.off, planKey, ReadingPlan));
    expect(stored.groups.length).toBe(2);
    const { structures } = await run.off(structuresOf(ctx.off, manifest.value));
    const realHunks = new Map(
      manifest.value.hunks.map((hunk) => [hunk.hunkId, hunk]),
    );
    for (const group of stored.groups) {
      const step = async (which: "off" | "on") =>
        readingStep(
          ctx[which],
          run[which],
          async () => {
            throw new Error("Assess reads no range view");
          },
          {
            kind: "assess",
            params: {
              plan: planKey,
              group: group.id,
              rank: group.rank,
              manifest: manifest.key,
              part: "read",
            },
          },
        );
      const parent = erased(
        assessStep({
          stage: "verify",
          reading: renderReading(stored, group.id, {
            for: "assess",
            hunks: realHunks,
            structures,
            proofs: [],
          }),
        }),
      );
      const offStep = await step("off");
      expect(offStep.spec.task).toBe(parent.spec.task);
      expect(offStep.spec.system).toBe(assessSystem);
      expect(offStep.opVersion).toBe(parent.opVersion);
      expect(offStep.inputs).toEqual(parent.inputs);
      expect(keyOf(offStep, ctx.off.config)).toBe(
        keyOf(parent, ctx.off.config),
      );
      const onStep = await step("on");
      expect(onStep.spec.task).toContain(SCOPE_LEGEND.tests);
      expect(onStep.spec.task.replace(`\n${SCOPE_LEGEND.tests}`, "")).toBe(
        parent.spec.task,
      );
      expect(onStep.inputs["recipe"]).toBe(READING_RECIPE_SCOPE_AND_TESTS);
      expect(keyOf(onStep, ctx.on.config)).not.toBe(
        keyOf(parent, ctx.on.config),
      );
      // Lane review's reading of the real group: off, the parent's; on, each file is marked
      // uncovered (no row was given) and the other group's file is named.
      const lane = (scopeAndTests?: boolean) =>
        renderReading(stored, group.id, {
          for: "lane-review",
          hunks: realHunks,
          structures,
          ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
        });
      expect(lane(false).text).toBe(lane().text);
      const other = stored.groups.find((g) => g.id !== group.id)!.paths[0]!;
      expect(lane(true).text).toContain(UNCOVERED_LINE);
      expect(lane(true).text).toContain(`path: ${other}`);
      expect(lane().text).not.toContain(UNCOVERED_LINE);
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
  },
  120_000,
);

// ---------------------------------------------------------------------------------------------
// 2. On, Lane review: scope
// ---------------------------------------------------------------------------------------------

/** The text of one file's block in a reading: the part that holds its path line. */
const blockOf = (text: string, path: string) =>
  text.split("\n\n").find((part) => part.includes(`\npath: ${path}\n`)) ?? "";

/** A range of `count` one-line text files, each in its own directory, read one per group. */
const manyFiles = (count: number) => {
  const paths = Array.from(
    { length: count },
    (_, at) => `d${String(at).padStart(2, "0")}/f.txt`,
  );
  const before = "a\n";
  const after = "b\n";
  const none = noStructure("unsupported-language", null, 0);
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), none],
    [oidOf(after), none],
  ]);
  const many = paths.flatMap((path) => diff(path, before, after));
  const of = planReadings({ hunks: many, structures, bounds: { maxFiles: 1 } });
  return {
    paths,
    plan: of,
    sources: {
      hunks: new Map(many.map((hunk) => [hunk.hunkId, hunk])),
      structures,
    },
  };
};

// Reason: the out-of-scope misses were "not asked".
test("on, Lane review's reading marks each file no done-when row covers, names the change's other files within the bound, and an answer naming a section not asked for is accepted, counted and decided as unsure is today", () => {
  const off = renderReading(plan, src.id, {
    for: "lane-review",
    ...sources,
    rows: ROWS,
  });
  const on = renderReading(plan, src.id, {
    for: "lane-review",
    ...sources,
    rows: ROWS,
    scopeAndTests: true,
  });
  // The file a row covers is not marked; the group's other two files are.
  expect(blockOf(on.text, "src/parse.ts")).toContain("row D1");
  expect(blockOf(on.text, "src/parse.ts")).not.toContain(UNCOVERED_LINE);
  for (const path of ["src/old.ts", "src/parse.test.ts"])
    expect(blockOf(on.text, path).split("\n")).toContain(UNCOVERED_LINE);
  expect(on.text).toContain(SCOPE_LEGEND.uncovered);
  // This plan reads every file in one group: no other file, so no list and no legend line for it
  // (the list is below, on a range read one file per group).
  const others = [...new Set(plan.sections.map((s) => s.path))].filter(
    (path) => !src.paths.includes(path),
  );
  expect(others).toEqual([]);
  expect(on.text).not.toContain(SCOPE_LEGEND.others);
  expect(on.text).not.toContain("Other files of this change");
  // Nothing else of the reading moves: with the added lines taken out, its lines are the parent's
  // (a data block's tag hashes its body, so the tag lines are left out of both).
  const lines = (text: string) =>
    text
      .split("\n")
      .filter(
        (line) => !line.startsWith("<data-") && !line.startsWith("</data-"),
      );
  expect(
    lines(on.text).filter(
      (line) =>
        line !== UNCOVERED_LINE &&
        line !== SCOPE_LEGEND.uncovered &&
        line !== SCOPE_LEGEND.others &&
        line !== "Other files of this change" &&
        !(line.startsWith("path: ") && others.includes(line.slice(6))) &&
        line !== "",
    ),
  ).toEqual(lines(off.text).filter((line) => line !== ""));
  // The bound: 25 files read one per group; a reading lists the other 24 to `OTHER_FILES`, then a count.
  const big = manyFiles(25);
  const first = big.plan.groups.find((g) => g.paths[0] === big.paths[0])!;
  const listed = renderReading(big.plan, first.id, {
    for: "lane-review",
    ...big.sources,
    scopeAndTests: true,
  }).text;
  expect(OTHER_FILES).toBe(20);
  const named = big.paths.filter((path) => path !== big.paths[0]);
  for (const path of named.slice(0, OTHER_FILES))
    expect(listed).toContain(`path: ${path}`);
  for (const path of named.slice(OTHER_FILES))
    expect(listed).not.toContain(`path: ${path}`);
  expect(listed.split("\n")).toContain(
    `and ${named.length - OTHER_FILES} more`,
  );
  expect(listed).toContain(SCOPE_LEGEND.others);
  expect(listed).toContain("Other files of this change");
  // Within the bound, every other file, in the plan's order, and no count.
  const small = manyFiles(3);
  const head = small.plan.groups.find((g) => g.paths[0] === small.paths[0])!;
  const few = renderReading(small.plan, head.id, {
    for: "lane-review",
    ...small.sources,
    scopeAndTests: true,
  }).text;
  expect(few.split("\n").filter((line) => line.startsWith("path: "))).toEqual(
    small.paths.map((path) => `path: ${path}`),
  );
  expect(few).not.toMatch(/^and \d+ more$/m);

  // The answer: the test file's section is unsure because nothing asks for it.
  const step = reviewOf(src.id, true);
  const reading = on;
  const test = reading.index.sections.find(
    (s) =>
      reading.index.files.find((f) => f.index === s.file)!.path ===
      "src/parse.test.ts",
  )!;
  const rest = reading.index.sections.filter((s) => s.index !== test.index);
  const answer = {
    files: [...new Set(reading.index.sections.map((s) => s.file))].map((f) => ({
      f,
      checked: "Read the rows.",
      rows:
        reading.index.files.find((file) => file.index === f)!.rows.length > 0
          ? [
              {
                row: "D1",
                reading: "",
                status: "no-evidence" as const,
                cites: [],
              },
            ]
          : null,
    })),
    sections: { a: rest.map((s) => s.index), r: [], u: [test.index] },
    comments: [],
    unsure: [
      { s: test.index, t: "Neither the goal nor D1 asks for this test." },
    ],
    notAsked: [test.index],
    crossBatchClaims: [],
  };
  expect(LaneReviewScopedAnswer.safeParse(answer).success).toBe(true);
  // Off, the form refuses the key; on, the answer has no problem that costs a turn.
  expect(LaneReviewAnswer.safeParse(answer).success).toBe(false);
  expect(laneReviewIssues(answer, reading.index, true)).toEqual([]);
  const stored = LaneReviewStored.parse(step.compose(result(answer)));
  expect(notAskedCount(stored)).toBe(1);
  const judged = laneReviewExpand(stored.answer, reading.index);
  const mine = judged.find((j) => j.section === test.index)!.judgement;
  expect(mine.verdict).toBe("unsure");
  expect(mine.notAsked).toBe(true);
  expect(judged.filter((j) => j.judgement.notAsked === true)).toHaveLength(1);
  // Decided where unsure lands today: the same decision as an unsure section with no reason.
  const decided = decideSection({
    ...inputFor({ review: "unsure" }),
    review: { judged: true, judgement: mine },
  });
  const today = decideSection(inputFor({ review: "unsure" }));
  expect(decided).toEqual(today);
  expect(decided.settled && decided.entry.undecided).toEqual({
    cause: "unsure",
    reading: "lane-review",
  });
  expect(decided.settled && decided.entry.lane.applied).toBe("human-required");
  // A section named not asked for but approved is sent back once, then dropped from the list; the
  // approval stands as written, so nothing is moved by the reason alone.
  const approved = {
    ...answer,
    sections: { a: reading.index.sections.map((s) => s.index), r: [], u: [] },
    unsure: [],
  };
  expect(
    laneReviewIssues(approved, reading.index, true).map((p) => p.class),
  ).toEqual(["not-asked-off-unsure"]);
  const repaired = laneReviewRepair(approved, reading.index, true).answer!;
  expect("notAsked" in repaired && repaired.notAsked).toEqual([]);
  expect(repaired.sections.a).toEqual(approved.sections.a);
});

// Reason: the gates lane must list which sections lane review marked not asked for, and the store
// holds no list of a reading's section keys in order; a re-read numbers its sections among its own.
test("on, a Lane review row names the sections not asked for by their identity keys, on a read and on a re-read numbered among its own sections; off, the field is absent", () => {
  const testKey = plan.sections.find(
    (s) => s.path === "src/parse.test.ts",
  )!.key;
  /** The row's scope-and-tests fields for a stored answer of one reading, marking `testKey` not asked for. */
  const rowOf = (
    only: ReadonlyArray<string> | undefined,
    config: Pick<ReadingsConfig, "scopeAndTests">,
    part: "read" | "reread" | "claim",
  ) => {
    const reading = renderReading(plan, src.id, {
      for: "lane-review",
      ...sources,
      rows: ROWS,
      only,
      scopeAndTests: true,
    });
    const at = reading.index.sections.find((s) => s.key === testKey)!.index;
    const answer = {
      files: [...new Set(reading.index.sections.map((s) => s.file))].map(
        (f) => ({ f, checked: "Read the rows.", rows: null }),
      ),
      sections: {
        a: reading.index.sections
          .filter((s) => s.index !== at)
          .map((s) => s.index),
        r: [],
        u: [at],
      },
      comments: [],
      unsure: [{ s: at, t: "Nothing asks for this test." }],
      notAsked: [at],
      crossBatchClaims: [],
    };
    const stored = LaneReviewStored.parse(
      erased(
        laneReviewStep({
          stage: "verify",
          reading,
          goal: GOAL,
          tools: [],
          keys: { frame: "frame-a", manifest: "manifest-a" },
          scopeAndTests: true,
        }),
      ).compose(result(answer)),
    );
    return {
      at,
      fields: scopeAndTestsFields(config, "lane-review", part, stored, plan),
    };
  };
  const read = rowOf(undefined, { scopeAndTests: true }, "read");
  const reread = rowOf([testKey], { scopeAndTests: true }, "reread");
  // The numbering differs between the two; the key is the same.
  expect(read.at).not.toBe(reread.at);
  expect(reread.at).toBe(1);
  for (const row of [read, reread])
    expect(row.fields).toEqual({ notAsked: 1, notAskedSections: [testKey] });
  // Off, and on a claim check, the row has none of it.
  expect(rowOf(undefined, {}, "read").fields).toEqual({});
  expect(rowOf([testKey], {}, "reread").fields).toEqual({});
  expect(rowOf([testKey], { scopeAndTests: true }, "claim").fields).toEqual({});
});

// ---------------------------------------------------------------------------------------------
// 3. On, Assess: testedBy is checked like every cite, and decides nothing
// ---------------------------------------------------------------------------------------------

const assessReading = (scopeAndTests?: boolean) =>
  renderReading(plan, src.id, {
    for: "assess",
    ...sources,
    ...(scopeAndTests === undefined ? {} : { scopeAndTests }),
  });

/**
 * One class over every section of the reading, with one requirement on the parser's line: testable
 * unless a reason is given; with `testedBy` (the tested form) unless it is null (the base form).
 */
const testedAnswer = (
  testedBy: ReadonlyArray<string> | null,
  untested = "",
) => {
  const reading = assessReading(true);
  const fileOf = (path: string) =>
    reading.index.files.find((file) => file.path === path)!.index;
  return {
    factors: [],
    requirements: [
      {
        t: "Counting returns the number of parsed items.",
        kinds: ["test-run" as const],
        cites: [`${fileOf("src/parse.ts")}n4`],
        testable: untested === "",
        untested,
        ...(testedBy === null ? {} : { testedBy: [...testedBy] }),
        proof: [],
        agree: true,
      },
    ],
    impact: [],
    classes: [
      {
        S: reading.index.sections.map((s) => s.index),
        c: "l" as const,
        v: "e" as const,
        F: [],
        R: [0],
        person: null,
        gaps: null,
      },
    ],
  };
};

// Reason: the missing-test misses were "not asked"; and by the owner's ruling a shown test is a
// hint, never evidence, so code must decide the same whatever `testedBy` says.
test("on, Assess's testedBy citing a shown test row is accepted, one citing any other row is refused, and the same answer with testedBy empty or filled gives the same decision, gaps and lane", () => {
  const reading = assessReading(true);
  expect(reading.text).toContain(SCOPE_LEGEND.tests);
  expect(assessReading().text).not.toContain(SCOPE_LEGEND.tests);
  const fileOf = (path: string) =>
    reading.index.files.find((file) => file.path === path)!.index;
  const testRows = `${fileOf("src/parse.test.ts")}n4-6`;
  const filled = testedAnswer([testRows]);
  const empty = testedAnswer([]);
  expect(AssessTestedAnswer.safeParse(filled).success).toBe(true);
  // The forms do not mix: off refuses `testedBy`, and on, an answer without it is not the schema.
  expect(AssessAnswer.safeParse(filled).success).toBe(false);
  expect(AssessTestedAnswer.safeParse(testedAnswer(null)).success).toBe(false);
  expect(AssessAnswer.safeParse(testedAnswer(null)).success).toBe(true);
  expect(assessIssues(filled, reading.index).map((p) => p.class)).toContain(
    "not-the-schema",
  );
  expect(assessIssues(filled, reading.index, true)).toEqual([]);
  // A changed row of a file not declared test, and a row the reading does not list, are refused.
  for (const cite of [`${fileOf("src/parse.ts")}n4`, "9n1"]) {
    const refused = testedAnswer([cite]);
    expect(
      assessIssues(refused, reading.index, true).map((p) => p.class),
    ).toEqual(["unknown-test"]);
    const repaired = assessRepair(refused, reading.index, true).answer!;
    expect(
      repaired.requirements.map((r) => ("testedBy" in r ? r.testedBy : null)),
    ).toEqual([[]]);
  }
  // Stored through the step, counted: one requirement, testable, exercised or not.
  const step = assessOf(src.id, true);
  const storedFilled = AssessStored.parse(step.compose(result(filled)));
  const storedEmpty = AssessStored.parse(step.compose(result(empty)));
  expect(testedByCounts(storedFilled, plan)).toEqual({
    requirements: 1,
    testable: 1,
    empty: 0,
  });
  expect(testedByCounts(storedEmpty, plan)).toEqual({
    requirements: 1,
    testable: 1,
    empty: 1,
  });
  // A reading that shows no test row counts nothing.
  const big = manyFiles(2);
  const notesReading = renderReading(big.plan, big.plan.groups[0]!.id, {
    for: "assess",
    ...big.sources,
    scopeAndTests: true,
  });
  const notesStored = AssessStored.parse(
    erased(
      assessStep({
        stage: "verify",
        reading: notesReading,
        scopeAndTests: true,
      }),
    ).compose(
      result({
        factors: [],
        requirements: [],
        impact: [],
        classes: [
          {
            S: notesReading.index.sections.map((s) => s.index),
            c: "l",
            v: "e",
            F: [],
            R: [],
            person: null,
            gaps: null,
          },
        ],
      }),
    ),
  );
  expect(testedByCounts(notesStored, big.plan)).toBeNull();

  // The same answer, testedBy filled or empty: the same decision, gaps and lane for every section.
  const expanded = (answer: unknown) => assessExpand(answer, reading.index);
  const [withTests, withoutTests] = [
    expanded(storedFilled.answer),
    expanded(storedEmpty.answer),
  ];
  expect(withTests.length).toBe(reading.index.sections.length);
  expect(
    withTests.some(
      (j) =>
        j.judgement.easeOfValidation.requirements[0]!.testedBy!.length === 1,
    ),
  ).toBe(true);
  for (const [at, judged] of withTests.entries()) {
    const other = withoutTests[at]!;
    for (const review of ["approve", "unsure"] as const)
      for (const relations of [true, false]) {
        const decide = (judgement: typeof judged.judgement) =>
          decideSection({
            ...inputFor({ review, relations }),
            assess: { judged: true, judgement },
          });
        const a = decide(judged.judgement);
        const b = decide(other.judgement);
        expect(a).toEqual(b);
        expect(JSON.stringify(a)).not.toContain("testedBy");
      }
  }

  // On against off: the same requirement, untestable with a stated reason (and testable, with
  // none), keeps its `untested` and so its coverage, proof state and notes (`coverageOf`), and every
  // decision, whether `testedBy` is there or not.
  const offReading = assessReading();
  for (const untested of ["A browser run checks it; no test can.", ""]) {
    const on = assessExpand(
      AssessStored.parse(step.compose(result(testedAnswer([], untested))))
        .answer,
      reading.index,
    );
    const off = assessExpand(
      AssessStored.parse(
        assessOf(src.id).compose(result(testedAnswer(null, untested))),
      ).answer,
      offReading.index,
    );
    expect(on.length).toBe(off.length);
    for (const [at, judged] of on.entries()) {
      const { testedBy, ...rest } =
        judged.judgement.easeOfValidation.requirements[0]!;
      expect(testedBy).toEqual([]);
      const base = off[at]!.judgement.easeOfValidation.requirements[0]!;
      expect(rest).toEqual(base);
      expect(rest.untested).toBe(untested);
      for (const proofs of [RECORDS, new Map()])
        expect(coverageOf(rest, proofs)).toEqual(coverageOf(base, proofs));
      for (const review of ["approve", "unsure"] as const) {
        const decide = (judgement: typeof judged.judgement) =>
          decideSection({
            ...inputFor({ review }),
            assess: { judged: true, judgement },
          });
        expect(decide(judged.judgement)).toEqual(decide(off[at]!.judgement));
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 4. No gap or lane rule reads testedBy or test rows
// ---------------------------------------------------------------------------------------------

// Reason: by the owner's ruling, a test's presence must never lift a gap, lower a lane or settle
// anything; this pins it on the lane rule's own code, not on what the readings happen to send it.
test("the lane rule and the decision code never read testedBy, the not-asked list or a shown test row, and give the same lane whatever they say", () => {
  const root = join(import.meta.dir, "../src");
  for (const file of [
    "lane-rule.ts",
    "proof-state.ts",
    "readings/decide.ts",
    "readings/settled.ts",
    "readings/units.ts",
  ]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const name of [
      "testedBy",
      "notAsked",
      "testRow",
      "showsTests",
      "scopeAndTests",
    ])
      expect({ file, name, found: text.includes(name) }).toEqual({
        file,
        name,
        found: false,
      });
  }
  // On the rule itself: an assessment whose requirement says it is exercised, or not, places the
  // same, in every quadrant, with and without a gap.
  for (const complexity of ["low", "high"] as const)
    for (const ease of ["easy", "hard"] as const)
      for (const gaps of [[], [{ axis: "ease-of-validation" as const }]]) {
        const assessment = (testedBy: ReadonlyArray<string>) => ({
          complexity: {
            level: complexity,
            factors: [{ cites: ["a.ts:new:3-3"] }],
          },
          validation: {
            level: ease,
            requirements: [
              {
                cites: ["a.ts:new:3-3"],
                coverage: "missing" as const,
                requirement: "r",
                testedBy,
              },
            ],
          },
          lean: null,
          gaps,
        });
        expect(laneOf(assessment(["t.ts:new:1-2"]))).toEqual(
          laneOf(assessment([])),
        );
      }
  // And on a recorded entry: the stored lane recomputes the same.
  const decided = decideSection(inputFor({}));
  if (!decided.settled) throw new Error("settled expected");
  const entry = decided.entry;
  const withTested = {
    ...entry,
    assess: {
      ...entry.assess!,
      easeOfValidation: {
        ...entry.assess!.easeOfValidation,
        requirements: entry.assess!.easeOfValidation.requirements.map((r) => ({
          ...r,
          testedBy: ["t.ts:new:1-2"],
        })),
      },
    },
  };
  expect(recordedLane(withTested, [])).toEqual(recordedLane(entry, []));
});

// ---------------------------------------------------------------------------------------------
// 5. Neither prompt names the lane, the lane rule, or what an answer changes
// ---------------------------------------------------------------------------------------------

const FORBIDDEN =
  /lane|quadrant|route|routing|floor|agentic|static automation|human-suggested|human-required|who reviews|sent to a person|escalat/i;

// Reason: the readings must not steer by it.
test("on, neither prompt nor reading shows the lane, the lane rule, or that an answer changes who reviews, and Assess sees no goal or done-when row", () => {
  const assess = assessReading(true);
  const review = renderReading(plan, src.id, {
    for: "lane-review",
    ...sources,
    rows: ROWS,
    scopeAndTests: true,
  });
  const texts = [
    assessTestedSystem,
    laneReviewScopedSystem,
    assessTask(assess),
    laneReviewTask(review, GOAL),
    ...Object.values(SCOPE_LEGEND),
    ...Object.values(NOT_ASKED),
    ...Object.values(ASSESS_TESTED_LINES),
    UNCOVERED_LINE,
  ];
  for (const text of texts) expect(FORBIDDEN.test(text)).toBe(false);
  // The prompts moved only where meant: one sentence and one key each.
  expect(assessTestedSystem).toContain(ASSESS_TESTED_LINES.states);
  expect(assessTestedSystem).toContain(ASSESS_TESTED_LINES.key);
  expect(
    assessTestedSystem
      .replace(` ${ASSESS_TESTED_LINES.states}`, "")
      .replace(` ${ASSESS_TESTED_LINES.key};`, ""),
  ).toBe(assessSystem);
  expect(laneReviewScopedSystem).toContain(NOT_ASKED.sentence);
  expect(laneReviewScopedSystem).toContain(NOT_ASKED.key);
  for (const subject of [
    "scope fit",
    "correctness",
    "risky inputs",
    "whether tests catch the behavior",
    "crossBatchClaims",
  ])
    expect(laneReviewScopedSystem).toContain(subject);
  // Assess stays blind to goal and scope.
  for (const word of ["done-when", "goal", "D1", "Counting returns"])
    expect(assessTask(assess)).not.toContain(word);
  // On, the steps key apart from off, on their own versions.
  const on = { assess: assessOf(src.id, true), review: reviewOf(src.id, true) };
  expect([
    on.assess.opVersion,
    on.assess.inputs["answer"],
    on.assess.inputs["recipe"],
    // The readers' round 9 moved the variants from 12 and 11, with their base prompts.
  ]).toEqual([14, 7, READING_RECIPE_SCOPE_AND_TESTS]);
  expect([
    on.review.opVersion,
    on.review.inputs["answer"],
    on.review.inputs["recipe"],
  ]).toEqual([17, 8, READING_RECIPE_SCOPE_AND_TESTS]);
  expect(keyOf(on.assess)).not.toBe(keyOf(assessOf(src.id)));
  expect(keyOf(on.review)).not.toBe(keyOf(reviewOf(src.id)));
});
