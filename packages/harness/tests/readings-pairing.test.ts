import { oneBatchPlanMap } from "./fixtures/readings.ts";
// Why (NEU-148 WP6, round 10): a removed line that released something (a listener, a timer, a
// handle) is judged by the claim check on one section with no tools. Without the line that set it up,
// the check cannot confirm a request lane review made with its tools, and drops it. The plan now
// shows a removing section the lines of its declaration that name what the removed lines named, from
// the commit's trees, under fixed bounds; every step of the group renders the same stored rows. Each
// test names the result it pins and why.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { defaultConfig } from "../src/config.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { storedOutput } from "../src/pipeline.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { erased, type AgentStep } from "../src/pi/stages/agent.ts";
import { readingStep, structuresOf } from "../src/pi/stages/reading-task.ts";
import { stageRunner } from "../src/pi/stages/services.ts";
import { claimKey, claimVerifyStep } from "../src/readings/claims.ts";
import { storePlan } from "../src/readings/collect.ts";
import {
  COMMON_ROWS,
  PER_GROUP,
  PER_SECTION,
  namesOf,
} from "../src/readings/pairing.ts";
import {
  ReadingPlan,
  pairPlan,
  pairingBlobs,
  planReadings,
} from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import {
  LaneReviewStored,
  assessStep,
  laneReviewOutcomes,
  laneReviewStep,
} from "../src/readings/steps.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import type { BlobStructure } from "../src/sections.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import {
  diff,
  mixedRange,
  oidOf,
  symbolStructure,
} from "./fixtures/readings.ts";

const directory = mkdtempSync(join(tmpdir(), "readings-pairing-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------
// Ranges built by hand
// ---------------------------------------------------------------------------------------------

/** A listener added in a function and released in the closure it returns; the release is removed. */
const WATCH_BEFORE = `export function watch(target: EventTarget) {
  const onKey = (event: Event) => {
    console.log(event.type);
  };
  target.addEventListener("keydown", onKey);
  return () => {
    target.removeEventListener("keydown", onKey);
    console.log("stopped");
  };
}
`;
/** Three lines added above it, so every head line of `watch` is three past its base line. */
const WATCH_AFTER = `export function ready() {
  return true;
}
export function watch(target: EventTarget) {
  const onKey = (event: Event) => {
    console.log(event.type);
  };
  target.addEventListener("keydown", onKey);
  return () => {
    console.log("stopped");
  };
}
`;
const EXTRA_BEFORE = `export function extra() {
  return 1;
}
`;
const EXTRA_AFTER = `export function extra() {
  return 1;
}
export function more() {
  return 2;
}
`;

type Range = {
  readonly hunks: Array<ManifestHunk>;
  readonly structures: Map<string, BlobStructure>;
  readonly texts: Map<string, string>;
};

/** A range of files, each with its two texts and its declarations' spans on each side. */
const rangeOf = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly base: Parameters<typeof symbolStructure>[1];
    readonly head: Parameters<typeof symbolStructure>[1];
  }>,
): Range => {
  const hunks: Array<ManifestHunk> = [];
  const structures = new Map<string, BlobStructure>();
  const texts = new Map<string, string>();
  for (const file of files) {
    hunks.push(...diff(file.path, file.before, file.after));
    structures.set(oidOf(file.before), symbolStructure(file.before, file.base));
    structures.set(oidOf(file.after), symbolStructure(file.after, file.head));
    texts.set(oidOf(file.before), file.before);
    texts.set(oidOf(file.after), file.after);
  }
  return { hunks, structures, texts };
};

const watchRange = () =>
  rangeOf([
    {
      path: "src/watch.ts",
      before: WATCH_BEFORE,
      after: WATCH_AFTER,
      base: [{ start: 1, end: 10, kind: "declaration", name: "watch" }],
      head: [
        { start: 1, end: 3, kind: "declaration", name: "ready" },
        { start: 4, end: 12, kind: "declaration", name: "watch" },
      ],
    },
    {
      path: "lib/extra.ts",
      before: EXTRA_BEFORE,
      after: EXTRA_AFTER,
      base: [{ start: 1, end: 3, kind: "declaration", name: "extra" }],
      head: [
        { start: 1, end: 3, kind: "declaration", name: "extra" },
        { start: 4, end: 6, kind: "declaration", name: "more" },
      ],
    },
  ]);

/** The plan without pairing rows (the parent's), and with them from the range's texts. */
const plansOf = (
  range: Range,
  texts: ReadonlyMap<string, string> = range.texts,
  bounds: { readonly maxFiles?: number } = {},
) => {
  const hunks = new Map(range.hunks.map((hunk) => [hunk.hunkId, hunk]));
  const planned = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    bounds,
  });
  return { hunks, planned, plan: pairPlan(planned, hunks, texts) };
};

const sectionNamed = (plan: ReadingPlan, name: string) =>
  plan.sections.find((section) => section.name === name)!;
const groupOf = (plan: ReadingPlan, key: string) =>
  plan.groups.find((group) => group.keys.includes(key))!;
/** The pairing rows a reading text shows, in order. */
const pairedLines = (text: string) =>
  text.match(/^paired [on]\d+\t.*$/gm) ?? [];

const SET_UP = 'paired n8\t  target.addEventListener("keydown", onKey);';

// ---------------------------------------------------------------------------------------------
// 1. The set-up line, from the head tree, with its true line number
// ---------------------------------------------------------------------------------------------

// Reason: this is the fact the claim check lacked.
test("a section that removes a release line gets the set-up line of the same declaration, from the head tree, with its head line number", () => {
  const range = watchRange();
  const { hunks, plan } = plansOf(range);
  const watch = sectionNamed(plan, "watch");
  // The removal is inside a declaration that still exists: the section is on the head side.
  expect(watch.span).toEqual({ side: "new", startLine: 4, endLine: 12 });
  expect(watch.owned).toEqual([
    expect.objectContaining({ side: "old", startLine: 7, endLine: 7 }),
  ]);
  // The release named the target, the method and the handler; the string and keywords are no names.
  expect(namesOf('    target.removeEventListener("keydown", onKey);')).toEqual([
    "target",
    "removeEventListener",
    "onKey",
  ]);
  // Three lines of `watch` at the head name one of them: its signature, the handler and the set-up
  // line, numbered as the head tree numbers them (the set-up line is line 5 at the base).
  expect(watch.paired).toEqual([
    {
      side: "new",
      line: 4,
      text: "export function watch(target: EventTarget) {",
    },
    { side: "new", line: 5, text: "  const onKey = (event: Event) => {" },
    {
      side: "new",
      line: 8,
      text: '  target.addEventListener("keydown", onKey);',
    },
  ]);
  expect(WATCH_AFTER.split("\n")[7]).toBe(
    '  target.addEventListener("keydown", onKey);',
  );
  expect(WATCH_BEFORE.split("\n")[4]).toBe(
    '  target.addEventListener("keydown", onKey);',
  );
  // They come from the head blob alone: with only the base text given, there are none.
  expect(pairingBlobs(plan, hunks)).toEqual([oidOf(WATCH_AFTER)]);
  const baseOnly = plansOf(
    range,
    new Map([[oidOf(WATCH_BEFORE), WATCH_BEFORE]]),
  ).plan;
  expect(sectionNamed(baseOnly, "watch").paired).toBeUndefined();

  // The reading shows them after the section's changed rows, marked, with the legend's one line;
  // a pairing row cannot be cited.
  const group = groupOf(plan, watch.key);
  const reading = renderReading(plan, group.id, {
    for: "lane-review",
    hunks,
    structures: range.structures,
  });
  expect(reading.text).toContain(
    `- o7\t    target.removeEventListener("keydown", onKey);\n= \t    console.log("stopped");\npaired n4\texport function watch(target: EventTarget) {\npaired n5\t  const onKey = (event: Event) => {\n${SET_UP}`,
  );
  const legend = reading.text.split("\n\n")[0]!;
  expect(
    legend.split("\n").filter((line) => line.includes('"paired"')),
  ).toEqual([
    'A row marked "paired" after a section\'s changed rows is an unchanged line of the same declaration that names something a removed row of that section names, with its line number on the side shown. It says nothing about whether the removal is right. It is not a changed row and cannot be cited.',
  ]);
  // Its own line never words the row as a hint that the removal is a defect.
  expect(
    legend.split("\n").find((line) => line.includes('"paired"')),
  ).not.toMatch(/defect|wrong|bug|missing|leak|breaks|should|must|forgot/i);
  const file = reading.index.sections.find((s) => s.key === watch.key)!.file;
  expect(reading.index.resolve(`${file}n8`).kind).toBe("unknown");
  expect(reading.index.resolve(`${file}o7`).kind).toBe("lines");
});

// ---------------------------------------------------------------------------------------------
// 2. The bounds, and common names
// ---------------------------------------------------------------------------------------------

/** A function whose removed row names `alpha` and `beta`, each on four other lines. */
const releasing = (name: string) => ({
  before: `export function ${name}(alpha: number, beta: number) {
  const a1 = alpha + 1;
  const a2 = alpha + 2;
  const a3 = alpha + 3;
  const b1 = beta + 1;
  const b2 = beta + 2;
  const b3 = beta + 3;
  release(alpha, beta);
  return a1 + a2 + a3 + b1 + b2 + b3;
}
`,
  after: `export function ${name}(alpha: number, beta: number) {
  const a1 = alpha + 1;
  const a2 = alpha + 2;
  const a3 = alpha + 3;
  const b1 = beta + 1;
  const b2 = beta + 2;
  const b3 = beta + 3;
  return a1 + a2 + a3 + b1 + b2 + b3;
}
`,
});

/** A function whose removed rows name only a name nine other lines name, and keywords. */
const COMMON_BEFORE = `export function common(ctx: Context) {
  ctx.a = 1;
  ctx.b = 2;
  ctx.c = 3;
  ctx.d = 4;
  ctx.e = 5;
  ctx.f = 6;
  ctx.g = 7;
  ctx.h = 8;
  ctx.done();
  return null;
}
`;
const COMMON_AFTER = `export function common(ctx: Context) {
  ctx.a = 1;
  ctx.b = 2;
  ctx.c = 3;
  ctx.d = 4;
  ctx.e = 5;
  ctx.f = 6;
  ctx.g = 7;
  ctx.h = 8;
}
`;

// Reason: the text must not grow without limit.
test("the bound holds per section and per group, and a removed row naming only common names or keywords adds nothing", () => {
  // Per section: seven lines name what the removed row names; six are shown, the one naming both
  // first, then the earliest.
  const one = releasing("one");
  const single = plansOf(
    rangeOf([
      {
        path: "src/one.ts",
        ...one,
        base: [{ start: 1, end: 10, kind: "declaration", name: "one" }],
        head: [{ start: 1, end: 9, kind: "declaration", name: "one" }],
      },
    ]),
  ).plan;
  const rows = sectionNamed(single, "one").paired!;
  expect(PER_SECTION).toBe(6);
  expect(rows.map((row) => row.line)).toEqual([1, 2, 3, 4, 5, 6]);

  // Per group: five such sections in one group, in reading order; four keep six rows each, and the
  // fifth none, so the group shows exactly `PER_GROUP` rows.
  const names = ["g1", "g2", "g3", "g4", "g5"];
  const grouped = plansOf(
    rangeOf(
      names.map((name) => ({
        path: `src/${name}.ts`,
        ...releasing(name),
        base: [{ start: 1, end: 10, kind: "declaration" as const, name }],
        head: [{ start: 1, end: 9, kind: "declaration" as const, name }],
      })),
    ),
  ).plan;
  expect(grouped.groups).toHaveLength(1);
  expect(PER_GROUP).toBe(24);
  expect(
    names.map((name) => sectionNamed(grouped, name).paired?.length ?? 0),
  ).toEqual([6, 6, 6, 6, 0]);

  // Common names: `ctx` is named by nine lines (more than `COMMON_ROWS`), `done` by none, and
  // `return null` names nothing: the section's plan entry and its reading are the parent's.
  expect(COMMON_ROWS).toBe(8);
  expect(namesOf("  return null;")).toEqual([]);
  const range = rangeOf([
    {
      path: "src/common.ts",
      before: COMMON_BEFORE,
      after: COMMON_AFTER,
      base: [{ start: 1, end: 12, kind: "declaration", name: "common" }],
      head: [{ start: 1, end: 10, kind: "declaration", name: "common" }],
    },
  ]);
  const { hunks, planned, plan } = plansOf(range);
  const common = sectionNamed(plan, "common");
  expect(common.owned.some((owned) => owned.side === "old")).toBe(true);
  expect(common.paired).toBeUndefined();
  expect(JSON.stringify(plan)).toBe(JSON.stringify(planned));
  const sources = {
    for: "assess" as const,
    hunks,
    structures: range.structures,
  };
  expect(renderReading(plan, plan.groups[0]!.id, sources).text).toBe(
    renderReading(planned, planned.groups[0]!.id, sources).text,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. A declaration gone at the head
// ---------------------------------------------------------------------------------------------

const TIMER_BEFORE = `export function start(tick: () => void) {
  const timer = setInterval(tick, 1000);
  clearInterval(timer);
  return timer;
}
export function keep() {
  return 1;
}
`;
/** `start` is gone: its first and last lines and the release are removed, its other lines kept. */
const TIMER_AFTER = `  const timer = setInterval(tick, 1000);
  return timer;
export function keep() {
  return 1;
}
`;

// Reason: the head has nothing to show.
test("a declaration removed whole takes its rows from the base tree, numbered there", () => {
  // `start` is gone at the head (no counterpart there): its removed rows are a section on the base
  // side, and its rows are its base lines no hunk changed, numbered as the base tree numbers them.
  const range = rangeOf([
    {
      path: "src/timer.ts",
      before: TIMER_BEFORE,
      after: TIMER_AFTER,
      base: [
        { start: 1, end: 5, kind: "declaration", name: "start" },
        { start: 6, end: 8, kind: "declaration", name: "keep" },
      ],
      head: [{ start: 3, end: 5, kind: "declaration", name: "keep" }],
    },
  ]);
  const { hunks, plan } = plansOf(range);
  const start = sectionNamed(plan, "start");
  expect(start.span).toEqual({ side: "old", startLine: 1, endLine: 5 });
  expect(start.paired).toEqual([
    { side: "old", line: 2, text: "  const timer = setInterval(tick, 1000);" },
    { side: "old", line: 4, text: "  return timer;" },
  ]);
  // From the base blob alone: given only it, the rows are the same; given only the head, none.
  expect(pairingBlobs(plan, hunks)).toEqual([oidOf(TIMER_BEFORE)]);
  expect(
    sectionNamed(
      plansOf(range, new Map([[oidOf(TIMER_BEFORE), TIMER_BEFORE]])).plan,
      "start",
    ).paired,
  ).toEqual(start.paired);
  expect(
    sectionNamed(
      plansOf(range, new Map([[oidOf(TIMER_AFTER), TIMER_AFTER]])).plan,
      "start",
    ).paired,
  ).toBeUndefined();
  expect(start.owned.map((owned) => [owned.side, owned.startLine])).toEqual([
    ["old", 1],
    ["old", 3],
    ["old", 5],
  ]);
  const reading = renderReading(plan, groupOf(plan, start.key).id, {
    for: "assess",
    hunks,
    structures: range.structures,
  });
  expect(pairedLines(reading.text)).toEqual([
    "paired o2\t  const timer = setInterval(tick, 1000);",
    "paired o4\t  return timer;",
  ]);
});

// ---------------------------------------------------------------------------------------------
// 4. Nothing else moves
// ---------------------------------------------------------------------------------------------

const keyOf = (step: AgentStep<unknown, unknown>) =>
  Computations.computationKey(agentStageSpec(defaultConfig(), step.spec, step))
    .key;

/** The run key of `defaultConfig()` before the probe existed (`readings-probe.test.ts`). */
const BASE_RUN_KEY =
  // Re-pinned (round 25): the pipeline version moved from 11 to 12.
  "eb644e039b6bd267141e4fac4fd924486e3867fc70fdc0a37ce2a046631c5419";

// Reason: nothing else moves.
test("sections that remove nothing keep their text and key, groups without a removing section are byte for byte the parent's, and with readings absent nothing moves", () => {
  const range = watchRange();
  const { hunks, planned, plan } = plansOf(range, range.texts, {
    maxFiles: 1,
  });
  expect(plan.groups.map((group) => group.paths)).toEqual([
    ["lib/extra.ts"],
    ["src/watch.ts"],
  ]);
  // The plan moves only where a section has rows: every other section's entry, the groups, their
  // sizes and ranks are the parent's.
  expect({ ...plan, sections: [] }).toEqual({ ...planned, sections: [] });
  for (const [at, section] of plan.sections.entries())
    if (section.paired === undefined)
      expect(JSON.stringify(section)).toBe(
        JSON.stringify(planned.sections[at]),
      );
  const sources = { hunks, structures: range.structures };
  for (const section of plan.sections) {
    const group = groupOf(plan, section.key).id;
    const alone = (of: ReadingPlan) =>
      renderReading(of, group, {
        for: "lane-review",
        ...sources,
        only: [section.key],
      });
    const removes = section.owned.some((owned) => owned.side === "old");
    // A re-read or a claim check of one section: the same text, and the same claim check key,
    // unless the section removes rows.
    const claim = (of: ReadingPlan) =>
      keyOf(
        erased(
          claimVerifyStep({
            key: "c".repeat(64),
            section: section.key,
            comment: {
              path: section.path,
              side: "new",
              startLine: 1,
              endLine: 1,
              text: "t",
              fails: "",
            },
            reading: alone(of),
            turnLimit: 1,
          }),
        ),
      );
    if (removes) {
      expect(alone(plan).text).not.toBe(alone(planned).text);
      expect(claim(plan)).not.toBe(claim(planned));
    } else {
      expect(alone(plan).text).toBe(alone(planned).text);
      expect(claim(plan)).toBe(claim(planned));
    }
  }
  // The group with no removing section: Assess and Lane review texts and keys are the parent's.
  const lib = plan.groups[0]!.id;
  const steps = (of: ReadingPlan) => ({
    assess: erased(
      assessStep({
        stage: "verify",
        reading: renderReading(of, lib, { for: "assess", ...sources }),
      }),
    ),
    review: erased(
      laneReviewStep({
        stage: "verify",
        reading: renderReading(of, lib, { for: "lane-review", ...sources }),
        goal: { goal: "g", doneWhen: [] },
        tools: [],
        keys: { frame: "f", manifest: "m" },
      }),
    ),
  });
  const now = steps(plan);
  const parent = steps(planned);
  expect(now.assess.spec.task).toBe(parent.assess.spec.task);
  expect(now.review.spec.task).toBe(parent.review.spec.task);
  expect(keyOf(now.assess)).toBe(keyOf(parent.assess));
  expect(keyOf(now.review)).toBe(keyOf(parent.review));
  // No text given (a plan built before this round, or one whose blobs were left out) is the plan
  // without rows, byte for byte; so is the shared fixture range's plan.
  expect(JSON.stringify(pairPlan(planned, hunks, new Map()))).toBe(
    JSON.stringify(planned),
  );
  const mixed = mixedRange();
  const mixedPlan = planReadings({
    hunks: mixed.hunks,
    structures: mixed.structures,
    excluded: mixed.excluded,
  });
  expect(
    JSON.stringify(
      pairPlan(
        mixedPlan,
        new Map(mixed.hunks.map((hunk) => [hunk.hunkId, hunk])),
        new Map(),
      ),
    ),
  ).toBe(JSON.stringify(mixedPlan));
});

// ---------------------------------------------------------------------------------------------
// 5. The claim check sees the same rows, through the stored plan, in a real repository
// ---------------------------------------------------------------------------------------------

const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

/** A repository whose one commit removes the release line of `src/watch.ts`. */
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
  writeFileSync(join(repository, "src", "watch.ts"), WATCH_BEFORE);
  writeFileSync(join(repository, "lib", "extra.ts"), EXTRA_BEFORE);
  const base = commit("base");
  writeFileSync(join(repository, "src", "watch.ts"), WATCH_AFTER);
  writeFileSync(join(repository, "lib", "extra.ts"), EXTRA_AFTER);
  const head = commit("drop the release");
  // The working tree moves on after the commit: the rows must come from the commit's trees.
  writeFileSync(join(repository, "src", "watch.ts"), "// not the commit\n");
  return { repository, range: { baseOid: base, headOid: head } };
};

// Reason: the request is judged on what lane review saw.
test.skipIf(graph.skip)(
  "the claim check's text holds the same pairing rows as lane review's for that section, through the stored plan read from the commit's trees",
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
    const ctx = {
      location,
      repository,
      runId: mintUlid(),
      runKey: "f".repeat(64),
      range: { baseRef: "main", ...range },
      cycleId: mintUlid(),
      config: defaultConfig(),
      log: { path: "(memory)", write: () => {}, read: () => [] },
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    };
    const run = stageRunner(ctx, clients);
    const manifest = await run(
      frontManifest(
        repository,
        range,
        defaultManifestSettings(1_000_000),
        source,
      ),
    );
    // The plan as the readings store it: planned, then paired from the commit's blobs.
    const planKey = await run(
      storePlan(ctx, {
        manifestKey: manifest.key,
        bounds: DEFAULT_READING_BOUNDS,
        map: oneBatchPlanMap(manifest),
        manifest: manifest.value,
      }),
    );
    const plan = await run(storedOutput(ctx, planKey, ReadingPlan));
    const watch = plan.sections.find(
      (section) =>
        section.path === "src/watch.ts" &&
        section.owned.some((owned) => owned.side === "old"),
    )!;
    expect(watch.span?.side).toBe("new");
    expect(watch.paired).toContainEqual({
      side: "new",
      line: 8,
      text: '  target.addEventListener("keydown", onKey);',
    });

    // Lane review's reading of the group, and a stored answer requesting changes on the removal.
    const { structures } = await run(structuresOf(ctx, manifest.value));
    const hunks = new Map(
      manifest.value.hunks.map((hunk) => [hunk.hunkId, hunk]),
    );
    const group = groupOf(plan, watch.key);
    const review = renderReading(plan, group.id, {
      for: "lane-review",
      hunks,
      structures,
    });
    const shown = pairedLines(review.text);
    expect(shown).toContain(SET_UP);
    const at = review.index.sections.find((s) => s.key === watch.key)!;
    const stored = LaneReviewStored.parse({
      group: group.id,
      sections: review.sectionKeys,
      unanswered: [],
      characters: 0,
      classes: null,
      outside: null,
      source: "agent",
      listed: review.listed,
      problems: { first: null, given: {}, repaired: {} },
      answer: {
        files: [
          ...new Set(review.index.sections.map((section) => section.file)),
        ].map((f) => ({ f, checked: "Read the rows.", rows: null })),
        sections: {
          a: review.index.sections
            .filter((s) => s.index !== at.index)
            .map((s) => s.index),
          r: [at.index],
          u: [],
        },
        comments: [
          {
            s: at.index,
            side: "old",
            start: 7,
            end: 7,
            kind: "defect",
            effect: null,
            t: "The keydown listener is no longer removed.",
            cites: [`${at.file}o7`],
            fails: "Each stop leaves the listener on the target.",
            row: null,
          },
        ],
        unsure: [],
      },
    });
    const answerKey = await run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          { op: "test.lane-review", opVersion: 1, inputs: { name: "a" } },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(stored)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );
    const comment = laneReviewOutcomes(stored, plan).flatMap(({ outcome }) =>
      outcome.judged
        ? outcome.judgement.comments.filter((c) => c.kind === "defect")
        : [],
    )[0]!;

    // The claim check as production prepares it (`readingStep`): the stored plan's group, the one
    // section the claim is on.
    const claim = await readingStep(
      ctx,
      run,
      async () => {
        throw new Error("a claim check reads no range view");
      },
      {
        kind: "verify-claim",
        params: {
          plan: planKey,
          group: group.id,
          manifest: manifest.key,
          answer: answerKey,
          claim: claimKey(comment),
        },
      },
    );
    expect(pairedLines(claim.spec.task)).toEqual(shown);
    // So does an Assess re-read of that section alone.
    const reread = await readingStep(
      ctx,
      run,
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
          part: "reread",
          only: [watch.key],
        },
      },
    );
    expect(pairedLines(reread.spec.task)).toEqual(shown);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  },
  120_000,
);
