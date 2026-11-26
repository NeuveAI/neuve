// Why (NEU-148 WP6, round 6): a section reading is now shown who calls its changed code and which
// test file does, from the relations the review's relations task stored. Missing caller or test
// evidence is a gap that sends the work to a person (the owner's ruling), so the one place where
// missing evidence could silently become "fine" is the rule that removes the gap. These hold that
// rule, the rows a reading shows (only supported callers, from the head commit, capped), that both
// readings of a group are shown one stored decision made once and never waited for, the step keys,
// and that this consumer finds what the graph lane's own computation stored.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
  type TaskOutcome,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { GraphSnapshotCoverage, SourcePath } from "@neuve/graph-client";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { PipelineConfig, defaultConfig, runKeyFor } from "../src/config.ts";
import { readingsConfig } from "../src/request.ts";
import type { Settings } from "../src/settings.ts";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { agentStageSpec, type StageRecord } from "../src/pipeline.ts";
import { erased, type AgentStep } from "../src/pi/stages/agent.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { childId } from "../src/pi/stages/children.ts";
import type { FrontResult } from "../src/pi/stages/front-task.ts";
import {
  headGateOf,
  markReviewPublished,
  relationsGraphDirectory,
  relationsTask,
  type RelationsResult,
  type RelationsSideEnd,
} from "../src/pi/stages/relations-task.ts";
import {
  EVIDENCE_BOUND_MS,
  evidenceSpec,
  evidenceStored,
  evidenceWork,
  groupEvidence,
  headGateEndOf,
  readEvidence,
  readingTask,
  type ReadingTaskInput,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import { reviewStages } from "../src/pi/stages/index.ts";
import type { ReadingsPlanResult } from "../src/pi/stages/readings-plan-task.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import {
  RelationsIndexBuilder,
  relationSlices,
  relationsComputation,
  relationsIndexDecodes,
  relationsSpec,
  type RelationSlice,
  type RelationsSide,
} from "../src/relations.ts";
import type { LaneReviewJudgement } from "../src/readings/answers.ts";
import { claimVerifyStep } from "../src/readings/claims.ts";
import {
  CANDIDATES_PER_KIND,
  EVIDENCE_RECIPE,
  ROW_TEXT,
  SYMBOLS_PER_SECTION,
  callSitePaths,
  chooseRows,
  lifts,
  reachOf,
  relationSubjects,
  rowLifts,
  removalPlaces,
  rowsPerGroup,
  sectionEvidence,
  relationsGapCause,
  GroupEvidence as GroupEvidenceSchema,
  type GroupEvidence,
  type HeadGateEnd,
  type RelationsGapCause,
} from "../src/readings/evidence.ts";
import { CODE_GAPS } from "../src/readings/decide.ts";
import {
  READING_RECIPE,
  planReadings,
  removalAttribution,
  symbolRemovedOf,
  type ReadingPlan,
} from "../src/readings/plan.ts";
import { CALLER_ROWS } from "../src/readings/prompts.ts";
import {
  EVIDENCE_LEGEND,
  readingOrder,
  renderReading,
} from "../src/readings/reading.ts";
import {
  decideSections,
  type CollectedSection,
} from "../src/readings/settled.ts";
import { assessStep, laneReviewStep } from "../src/readings/steps.ts";
import { noStructure } from "../src/sections.ts";
import { manifestOf } from "./fixtures/link.ts";
import { headTestFilesOf } from "./fixtures/head-test-files.ts";
import { futureShape, withShows } from "./fixtures/readings-future-shape.ts";
import {
  RECORDS,
  diff,
  judgementFor,
  mixedRange,
  oidOf,
  symbolStructure,
} from "./fixtures/readings.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

// ---------------------------------------------------------------------------------------------
// A range of four files, and a relations index built by hand through the graph lane's builder
// ---------------------------------------------------------------------------------------------

const A_BEFORE = `import { log } from "./log";
export function f(x: number) {
  return x + 1;
}
export function h(y: number) {
  return y * 2;
}
export function q(z: number) {
  return z - 1;
}
`;
const A_AFTER = `import { log, warn } from "./log";
export function f(x: number) {
  return x + 2;
}
export function h(y: number) {
  return y * 3;
}
export function q(z: number) {
  return z - 2;
}
`;
const C_BEFORE = `export function keep() {
  return 1;
}
export function drop() {
  return 2;
}
`;
const C_AFTER = `export function keep() {
  return 1;
}
`;
const D_BEFORE = `export function box() {
  const a = () => 1;
  const b = () => 1;
  const c = () => 1;
  const dd = () => 1;
}
`;
const D_AFTER = D_BEFORE.replaceAll("=> 1", "=> 2");
const E_BEFORE = "export function e() {\n  return 1;\n}\n";
const E_AFTER = "export function e() {\n  return 2;\n}\n";

/** The callers' files at the head commit, by path: what a row's text is read from. */
const LONG = `  expect(f(${"1 + ".repeat(60)}1)).toBe(62);`;
const HEAD_FILES: Record<string, string> = {
  "b.ts": `import { f, h } from "./a";\nexport const g = () => f(1);\nconst k = () => h(2);\n`,
  "m.ts": `import { f } from "./a";\n\n\n\nexport const mm = () => f(4);\n`,
  "tests/b.test.ts": `import { f } from "../a";\ntest("f", () => {\n${LONG}\n});\n`,
  "tests/a.test.ts": `import { box } from "../d";\n\n\n\n\n\ntest("box", () => box());\n`,
  "a.ts": A_AFTER,
};
const lineAt = (path: string, line: number) =>
  HEAD_FILES[path]?.split("\n")[line - 1] ?? null;

type Structures = Parameters<typeof planReadings>[0]["structures"];
const structures = (fWithImport = false): Structures =>
  new Map([
    ...[A_BEFORE, A_AFTER].map(
      (text) =>
        [
          oidOf(text),
          symbolStructure(
            text,
            fWithImport
              ? [
                  // f's span takes in the import line: a range of it lies outside every symbol.
                  { start: 1, end: 4, kind: "declaration", name: "f" },
                  { start: 5, end: 7, kind: "declaration", name: "h" },
                  { start: 8, end: 10, kind: "declaration", name: "q" },
                ]
              : [
                  { start: 1, end: 1, kind: "imports" },
                  { start: 2, end: 4, kind: "declaration", name: "f" },
                  { start: 5, end: 7, kind: "declaration", name: "h" },
                  { start: 8, end: 10, kind: "declaration", name: "q" },
                ],
          ),
        ] as const,
    ),
    ...[C_BEFORE, C_AFTER].map(
      (text) =>
        [
          oidOf(text),
          symbolStructure(text, [
            { start: 1, end: 3, kind: "declaration", name: "keep" },
            ...(text === C_BEFORE
              ? [
                  {
                    start: 4,
                    end: 6,
                    kind: "declaration" as const,
                    name: "drop",
                  },
                ]
              : []),
          ]),
        ] as const,
    ),
    ...[D_BEFORE, D_AFTER].map(
      (text) =>
        [
          oidOf(text),
          symbolStructure(text, [
            { start: 1, end: 6, kind: "declaration", name: "box" },
          ]),
        ] as const,
    ),
    ...[E_BEFORE, E_AFTER].map(
      (text) =>
        [
          oidOf(text),
          symbolStructure(text, [
            { start: 1, end: 3, kind: "declaration", name: "e" },
          ]),
        ] as const,
    ),
  ]);

const HUNKS = [
  ...diff("a.ts", A_BEFORE, A_AFTER),
  ...diff("c.ts", C_BEFORE, C_AFTER),
  ...diff("d.ts", D_BEFORE, D_AFTER),
  ...diff("e.ts", E_BEFORE, E_AFTER),
];
const hunks = new Map(HUNKS.map((hunk) => [hunk.hunkId, hunk]));
const planOf = (fWithImport = false) =>
  planReadings({ hunks: HUNKS, structures: structures(fWithImport) });
const plan = planOf();
const group = plan.groups[0]!;

/** A section of the plan by its file and name; `imports` for the import section. */
const sectionOf = (path: string, name: string | null, of = plan) =>
  of.sections.find((s) => s.path === path && s.name === name)!;

const coverage = (): GraphSnapshotCoverage => ({
  provider: {
    name: "entire-graph",
    version: "fixture",
    identityRevision: "4",
    executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  },
  repoKey: "local/r",
  schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
  commit: "2".repeat(40),
  tree: "4".repeat(40),
  profile: "full",
  relationSet: ["CALLS", "CONSTRUCTS", "IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { TypeScript: "semantic" },
  counts: { files: 0, parsedFiles: 0, symbols: 0, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
});

type Sym = Readonly<{ id: string; path: string; start: number; end: number }>;
type Call = Readonly<{
  from: string;
  to: string;
  resolution?: string;
  line: number | null;
}>;

const SYMBOLS: ReadonlyArray<Sym> = [
  { id: "f", path: "a.ts", start: 2, end: 4 },
  { id: "h", path: "a.ts", start: 5, end: 7 },
  { id: "q", path: "a.ts", start: 8, end: 10 },
  { id: "g", path: "b.ts", start: 1, end: 3 },
  { id: "mm", path: "m.ts", start: 4, end: 6 },
  { id: "zz", path: "z.ts", start: 1, end: 2 },
  { id: "keep", path: "c.ts", start: 1, end: 3 },
  { id: "box", path: "d.ts", start: 1, end: 6 },
  { id: "a", path: "d.ts", start: 2, end: 2 },
  { id: "b", path: "d.ts", start: 3, end: 3 },
  { id: "c", path: "d.ts", start: 4, end: 4 },
  { id: "dd", path: "d.ts", start: 5, end: 5 },
];
const CALLS: ReadonlyArray<Call> = [
  // f: two callers outside tests, and two test files, the first by path with no line.
  { from: "g", to: "f", line: 2 },
  { from: "mm", to: "f", line: 5 },
  { from: "file:tests/a.test.ts", to: "f", line: null },
  { from: "file:tests/b.test.ts", to: "f", line: 3 },
  // h: a caller and no test; and a name match from a file that does not import a.ts.
  { from: "g", to: "h", line: 3 },
  { from: "zz", to: "h", resolution: "name_only", line: 1 },
  // box's four inner functions: each called and tested.
  ...["a", "b", "c", "dd"].flatMap((to) => [
    { from: "g", to, line: 2 },
    { from: "file:tests/a.test.ts", to, line: 7 },
  ]),
];

/** The head commit's index, through the graph lane's builder (its support rule included). */
const indexOf = async (
  over: {
    readonly symbols?: ReadonlyArray<Sym>;
    readonly calls?: ReadonlyArray<Call>;
  } = {},
) => {
  const symbols = over.symbols ?? SYMBOLS;
  const builder = new RelationsIndexBuilder();
  for (const path of [
    "a.ts",
    "b.ts",
    "m.ts",
    "z.ts",
    "c.ts",
    "d.ts",
    "k.ts",
    "tests/a.test.ts",
    "tests/b.test.ts",
  ])
    builder.file({
      id: `file:${path}`,
      path,
      language: "TypeScript",
      bytes: 1,
    });
  for (const symbol of symbols)
    builder.symbol({
      id: symbol.id,
      name: symbol.id,
      qualifiedName: symbol.id,
      kind: "function",
      language: "TypeScript",
      path: symbol.path,
      startLine: symbol.start,
      endLine: symbol.end,
      containerId: null,
      signature: null,
    });
  const pathOf = (id: string) =>
    id.startsWith("file:")
      ? id.slice(5)
      : (symbols.find((symbol) => symbol.id === id)?.path ?? "");
  for (const call of over.calls ?? CALLS)
    builder.relation({
      relation: "CALLS",
      fromId: call.from,
      toId: call.to,
      targetKind: "symbol",
      resolution: call.resolution ?? "exact",
      confidence: 0.8,
      scope: null,
      evidence: [
        {
          kind: "call_site",
          location:
            call.line === null
              ? { kind: "path", path: pathOf(call.from) as SourcePath }
              : {
                  kind: "point",
                  path: pathOf(call.from) as SourcePath,
                  line: call.line,
                },
          detail: null,
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
  return futureShape(await builder.finish(coverage()));
};

/** Every read section's slice, as the reading task cuts them: head only, tests under `tests/`. */
const slicesOf = (
  head: RelationsSide,
  of: ReadingPlan = plan,
  map: typeof hunks = hunks,
) =>
  new Map(
    relationSlices(
      { base: { gap: "over-bound", tag: null }, head },
      relationSubjects(of, map),
      {
        base: () => false,
        head: (path) => path.startsWith("tests/"),
      },
    ).map((slice): [string, RelationSlice] => [slice.key, slice]),
  );

const evidenceOf = (
  slices: ReadonlyMap<string, RelationSlice> | null,
  of: ReadingPlan = plan,
  relations: GroupEvidence["relations"] = { head: "head-key", base: null },
  lines: (path: string, line: number) => string | null = lineAt,
  map: typeof hunks = hunks,
  /** The callers' files whose test status is undecided (`UndecidedFiles`); none by default. */
  undecided: ReadonlySet<string> = new Set(),
): GroupEvidence => ({
  recipe: EVIDENCE_RECIPE,
  group: of.groups[0]!.id,
  outcome: "read",
  relations,
  sections: chooseRows(of, of.groups[0]!.id, slices, lines, map, undecided),
});

const stateOf = (evidence: GroupEvidence, key: string) =>
  evidence.sections.find((s) => s.key === key)?.relations;

const RELATIONS_GAP = CODE_GAPS.find(
  (g) => g.kind === "relations-unavailable",
)!;

/** Every section judged low and easy on proven requirements, and approved: the rule's best lane. */
const decided = (
  of: ReadingPlan,
  evidence: GroupEvidence,
  /** Every section's Assess judgement: low and easy on proven requirements unless given. */
  judgement = judgementFor("static-automation"),
) => {
  const collected = new Map<string, CollectedSection>(
    of.sections.map((section) => [
      section.key,
      {
        assess: { judged: true, judgement },
        review: {
          judged: true,
          judgement: {
            verdict: "approve",
            comments: [],
            checked: "",
            rows: [],
            unsure: [],
          } satisfies LaneReviewJudgement,
        },
        claims: [],
        steps: { assess: "a".repeat(64), review: "b".repeat(64) },
      },
    ]),
  );
  const { sections } = decideSections({
    plan: of,
    hunks,
    groups: [],
    collected,
    proofs: new Map(of.sections.map((s) => [s.path, RECORDS])),
    findings: [],
    excluded: [],
    relations: new Set(
      evidence.sections
        .filter((s) => s.relations === "shown")
        .map((s) => s.key),
    ),
  });
  return (key: string) => {
    const decision = sections.find((s) => s.section.key === key)!.decision!;
    if (!decision.settled) throw new Error("not settled");
    return {
      gap: decision.entry.assess!.gaps.some(
        (gap) => gap.kind === RELATIONS_GAP.kind,
      ),
      lane: decision.entry.lane.applied,
    };
  };
};

// Reason: this is the one place where missing evidence could silently become "fine". Round 9: the
// lift is the one place work can leave a person, and it now rests on caller rows alone (the owner's
// ruling, decision 14.19: a test is a hint, never evidence), and only on one that shows the call's
// own line (the coordinator's ruling of 13 November), so h, with such a caller and no test, is
// shown, and a section with test rows only keeps its gap.
// Reason (round 28, ruling 5): the blast radius is recorded before any threshold is set (14.22), so
// its parts must be the slice's own counts for the symbols a section needs evidence for, exactly the
// fields named, and a section whose head was not read must record nothing rather than zero.
test("each read section records its blast radius from its slice: callers, trusted callers, test callers, distinct calling files and changed-symbol edges; an unread section records none", async () => {
  // h also calls f, so both are joined by an edge between changed symbols.
  const slices = slicesOf(
    await indexOf({ calls: [...CALLS, { from: "h", to: "f", line: 6 }] }),
  );
  const reach = reachOf(plan, group.id, slices, hunks);
  const byKey = new Map(reach.map((r) => [r.key, r]));
  const f = sectionOf("a.ts", "f");
  const h = sectionOf("a.ts", "h");
  const e = sectionOf("e.ts", "e");
  // f: g (b.ts), mm (m.ts), h (a.ts) and the two test files, every one resolved.
  expect(byKey.get(f.key)).toEqual({
    key: f.key,
    symbols: 1,
    callers: 5,
    trusted: 5,
    testCallers: 2,
    files: 5,
    filesComplete: true,
    edges: 1,
  });
  // h: its edge out to f; the name-only match from z.ts is kept apart from the trusted count.
  const hReach = byKey.get(h.key)!;
  expect(hReach.edges).toBe(1);
  expect(hReach.trusted).toBeLessThanOrEqual(hReach.callers);
  expect(hReach.testCallers).toBe(0);
  // A file the head's relations hold no record of: nothing recorded, never a zero.
  expect(byKey.has(e.key)).toBe(false);
  // Every recorded part is its slice field's sum over the section's symbols, never a shown row.
  for (const entry of reach) {
    const symbols = slices
      .get(entry.key)!
      .head.symbols.filter((s) => s.innermost);
    expect(entry.symbols).toBeLessThanOrEqual(symbols.length);
    expect(entry.trusted).toBeLessThanOrEqual(entry.callers);
    expect(entry.testCallers).toBeLessThanOrEqual(entry.callers);
  }
  // No head stored: no section records anything.
  expect(reachOf(plan, group.id, null, hunks)).toEqual([]);
  // The stored form keeps it, and a decision without it still parses.
  const evidence = { ...evidenceOf(slices), reach };
  expect(GroupEvidenceSchema.parse(evidence).reach).toEqual(reach);
  expect(GroupEvidenceSchema.parse(evidenceOf(slices)).reach).toBeUndefined();
});

test("a section where the innermost symbol of every changed head line has a caller row showing its call, with its line's text, has no relations gap and takes the rule's lane, with or without a test row; a missing, lineless, unreadable or recursive caller, a test row alone, an unread side, a line outside every symbol or only in an enclosing class, or a cap keeps the gap", async () => {
  const index = await indexOf();
  const evidence = evidenceOf(slicesOf(index));
  const f = sectionOf("a.ts", "f");
  const h = sectionOf("a.ts", "h");
  const q = sectionOf("a.ts", "q");
  const imports = sectionOf("a.ts", null);
  const drop = sectionOf("c.ts", "drop");
  const box = sectionOf("d.ts", "box");
  const e = sectionOf("e.ts", "e");
  expect(
    Object.fromEntries(
      [f, h, q, imports, drop, box, e].map((s) => [
        `${s.path}:${s.name}`,
        stateOf(evidence, s.key),
      ]),
    ),
  ).toEqual({
    "a.ts:f": "shown",
    // A caller and no test caller: test rows count neither for nor against a lift.
    "a.ts:h": "shown",
    // Read, and nothing supported: no callers at all, a range outside every symbol, a section on
    // the old side only.
    "a.ts:q": "no-evidence",
    "a.ts:null": "no-evidence",
    "c.ts:drop": "no-evidence",
    // Four changed lines, each in its own inner function, each called and tested: one over the cap.
    "d.ts:box": "over-cap",
    // A file the head's relations hold no record of.
    "e.ts:e": "not-read",
  });
  const judged = decided(plan, evidence);
  // Shown whole: the gap is gone and the rule decides from the readings' levels alone.
  expect(judged(f.key)).toEqual({ gap: false, lane: "static-automation" });
  expect(judged(h.key)).toEqual({ gap: false, lane: "static-automation" });
  // Every other one keeps the gap, which sends it to a person; its words are code's own.
  for (const section of [q, imports, drop, box, e])
    expect(judged(section.key)).toEqual({ gap: true, lane: "human-suggested" });

  // The same section f, one condition at a time.
  // Its test callers gone: a caller row alone is enough.
  const noTests = evidenceOf(
    slicesOf(
      await indexOf({
        calls: CALLS.filter((c) => !(c.to === "f" && c.from.includes("test"))),
      }),
    ),
  );
  expect(stateOf(noTests, f.key)).toBe("shown");
  expect(decided(plan, noTests)(f.key).gap).toBe(false);
  // Its callers gone, its tests kept: a test row alone keeps the gap.
  const noCallers = evidenceOf(
    slicesOf(
      await indexOf({
        calls: CALLS.filter((c) => !(c.to === "f" && !c.from.includes("test"))),
      }),
    ),
  );
  expect(stateOf(noCallers, f.key)).toBe("partial");
  // The head's relations a gap (not stored in time, failed, no engine): nothing is read.
  const unread = evidenceOf(slicesOf({ gap: "over-bound", tag: null }));
  expect(unread.sections.every((s) => s.relations === "not-read")).toBe(true);
  expect(unread.sections.flatMap((s) => s.rows)).toEqual([]);
  // Nothing stored at all: no slices.
  expect(
    evidenceOf(null).sections.every((s) => s.relations === "not-read"),
  ).toBe(true);
  // f's span takes in the import line, which lies outside every symbol: its rows are still shown,
  // and the gap stays.
  const wide = planOf(true);
  const wideF = sectionOf("a.ts", "f", wide);
  const wideEvidence = evidenceOf(slicesOf(index, wide), wide);
  expect(stateOf(wideEvidence, wideF.key)).toBe("partial");
  expect(
    wideEvidence.sections.find((s) => s.key === wideF.key)!.rows,
  ).toHaveLength(2);
  // Four functions declared inside f's changed line, each called and tested: one over the cap.
  const inner = ["n1", "n2", "n3", "n4"];
  expect(inner.length).toBe(SYMBOLS_PER_SECTION + 1);
  const crowded = evidenceOf(
    slicesOf(
      await indexOf({
        symbols: [
          ...SYMBOLS,
          ...inner.map((id) => ({ id, path: "a.ts", start: 3, end: 3 })),
        ],
        calls: [
          ...CALLS,
          ...inner.flatMap((to) => [
            { from: "g", to, line: 2 },
            { from: "file:tests/b.test.ts", to, line: 3 },
          ]),
        ],
      }),
    ),
  );
  expect(stateOf(crowded, f.key)).toBe("over-cap");
  expect(
    crowded.sections.find((s) => s.key === f.key)!.rows.map((r) => r.symbol),
  ).toEqual(["n1", "n1", "n2", "n2", "n3", "n3"]);
  for (const variant of [noCallers, unread, wideEvidence, crowded]) {
    const of = variant === wideEvidence ? wide : plan;
    const key = variant === wideEvidence ? wideF.key : f.key;
    expect(decided(of, variant)(key).gap).toBe(true);
  }

  // The group's row cap, in reading order, every caller row before any test row: at two rows per
  // section a group may hold, a group of at most two sections shows four rows. box's three caller
  // rows and f's take them; the test rows past them are left out and change no section's state, so
  // f is still shown (a test row is never why a section keeps or loses its gap).
  const tight: ReadingPlan = {
    ...plan,
    bounds: { ...plan.bounds, maxItems: 2 },
    groups: [{ ...group, keys: [box.key, f.key], paths: ["d.ts", "a.ts"] }],
  };
  expect(rowsPerGroup(tight.bounds)).toBe(4);
  const capped = evidenceOf(slicesOf(index), tight);
  expect(
    capped.sections.map((s) => [s.relations, s.rows.map((r) => r.kind)]),
  ).toEqual([
    ["over-cap", ["caller", "caller", "caller"]],
    ["shown", ["caller"]],
  ]);
  // A caller row past the cap is left out and its section keeps its gap.
  const tighter: ReadingPlan = {
    ...tight,
    bounds: { ...plan.bounds, maxItems: 1 },
  };
  expect(rowsPerGroup(tighter.bounds)).toBe(2);
  const cut = evidenceOf(slicesOf(index), tighter);
  expect(cut.sections.map((s) => [s.relations, s.rows.length])).toEqual([
    ["over-cap", 2],
    ["over-cap", 0],
  ]);
  expect(decided(plan, cut)(f.key).gap).toBe(true);
  expect(rowsPerGroup(plan.bounds)).toBe(80);

  // Round 6b. A call site Graph gave no line for lifts nothing. Round 9: such a site shows only its
  // caller (`caller`), so it is shown by the caller's name and path, with no line and no text, as
  // context, and the gap stays.
  const lineless = evidenceOf(
    slicesOf(
      await indexOf({
        calls: [
          ...CALLS.filter((c) => c.to !== "f"),
          { from: "g", to: "f", line: null },
          { from: "file:tests/b.test.ts", to: "f", line: null },
        ],
      }),
    ),
  );
  expect(lineless.sections.find((s) => s.key === f.key)).toEqual({
    key: f.key,
    relations: "partial",
    rows: [
      {
        kind: "caller",
        symbol: "f",
        path: "b.ts",
        shows: "caller",
        line: null,
        text: null,
        from: "g",
        confirmed: true,
      },
      {
        kind: "test",
        symbol: "f",
        path: "tests/b.test.ts",
        shows: "caller",
        line: null,
        text: null,
        from: null,
        confirmed: true,
      },
    ],
  });
  expect(decided(plan, lineless)(f.key).gap).toBe(true);
  // A line the head tree does not give (past the end of the file, a blank line, or no text at all
  // for the path: a blob the read left out, a path that is no blob) is no row either.
  const unreadable = evidenceOf(
    slicesOf(
      await indexOf({
        calls: [
          ...CALLS.filter((c) => c.to !== "f"),
          { from: "g", to: "f", line: 999 },
          { from: "mm", to: "f", line: 2 },
          { from: "file:tests/b.test.ts", to: "f", line: 999 },
        ],
      }),
    ),
  );
  expect(unreadable.sections.find((s) => s.key === f.key)).toEqual({
    key: f.key,
    relations: "no-evidence",
    rows: [],
  });
  expect(decided(plan, unreadable)(f.key).gap).toBe(true);
  const noText = evidenceOf(slicesOf(index), plan, undefined, () => null);
  // Only rows with no line are left: a site that shows its caller alone needs no text.
  expect(
    noText.sections
      .flatMap((s) => s.rows)
      .map((r) => [r.shows, r.line, r.text]),
  ).toEqual([["caller", null, null]]);
  expect(noText.sections.some((s) => s.relations === "shown")).toBe(false);
  // An unreadable call site gives way to the next caller of its kind whose line is there.
  const fallback = evidenceOf(
    slicesOf(
      await indexOf({
        calls: [
          ...CALLS.filter((c) => !(c.to === "f" && c.from === "g")),
          { from: "g", to: "f", line: 999 },
        ],
      }),
    ),
  );
  expect(stateOf(fallback, f.key)).toBe("shown");
  expect(
    fallback.sections.find((s) => s.key === f.key)!.rows.map((r) => r.path),
  ).toEqual(["m.ts", "tests/b.test.ts"]);

  // A function's own recursive call is never its caller: with no other caller outside tests, f has
  // a test row alone, and the gap stays.
  const recursive = evidenceOf(
    slicesOf(
      await indexOf({
        calls: [
          ...CALLS.filter((c) => !(c.to === "f" && !c.from.includes("test"))),
          { from: "f", to: "f", line: 3 },
        ],
      }),
    ),
  );
  expect(stateOf(recursive, f.key)).toBe("partial");
  expect(
    recursive.sections.find((s) => s.key === f.key)!.rows.map((r) => r.kind),
  ).toEqual(["test"]);
  expect(decided(plan, recursive)(f.key).gap).toBe(true);

  // A changed line whose innermost enclosing symbol is the class, not the method: class Box with
  // two changed field lines around a changed method open. open's caller and test leave Box's own
  // lines without evidence, so the gap stays; once Box has both rows too, it goes.
  const K_BEFORE =
    "export class Box {\n  a = 1;\n  open() { return 1; }\n  b = 1;\n}\n";
  const K_AFTER =
    "export class Box {\n  a = 2;\n  open() { return 2; }\n  b = 2;\n}\n";
  const kHunks = diff("k.ts", K_BEFORE, K_AFTER);
  const kMap = new Map(kHunks.map((hunk) => [hunk.hunkId, hunk]));
  const kPlan = planReadings({
    hunks: kHunks,
    structures: new Map(
      [K_BEFORE, K_AFTER].map((text) => [
        oidOf(text),
        symbolStructure(text, [
          { start: 1, end: 5, kind: "declaration", name: "Box" },
        ]),
      ]),
    ),
  });
  const boxSection = kPlan.sections[0]!;
  expect(kPlan.sections).toHaveLength(1);
  const kSymbols = [
    ...SYMBOLS,
    { id: "Box", path: "k.ts", start: 1, end: 5 },
    { id: "open", path: "k.ts", start: 3, end: 3 },
  ];
  const openCalled = [
    ...CALLS,
    { from: "g", to: "open", line: 2 },
    { from: "file:tests/b.test.ts", to: "open", line: 3 },
  ];
  const classOnly = evidenceOf(
    slicesOf(
      await indexOf({ symbols: kSymbols, calls: openCalled }),
      kPlan,
      kMap,
    ),
    kPlan,
    undefined,
    undefined,
    kMap,
  );
  expect(classOnly.sections[0]!.relations).toBe("partial");
  expect(classOnly.sections[0]!.rows.map((r) => r.symbol)).toEqual([
    "open",
    "open",
  ]);
  const boxCalled = evidenceOf(
    slicesOf(
      await indexOf({
        symbols: kSymbols,
        calls: [
          ...openCalled,
          { from: "mm", to: "Box", line: 5 },
          { from: "file:tests/a.test.ts", to: "Box", line: 7 },
        ],
      }),
      kPlan,
      kMap,
    ),
    kPlan,
    undefined,
    undefined,
    kMap,
  );
  expect(boxCalled.sections[0]!.relations).toBe("shown");
  expect(boxCalled.sections[0]!.rows.map((r) => r.symbol)).toEqual([
    "open",
    "open",
    "Box",
    "Box",
  ]);
  expect(boxSection.key).toBe(boxCalled.sections[0]!.key);
});

// Reason (round 13, the owner's ruling: no A/B, the lift is the behaviour): a decision has no switch,
// so a section whose caller rows all lift is shown and loses its gap; an undecided caller's file
// keeps it (unknown means no lift); and the stored form refuses a shown section only from a decision
// that read nothing.
test("the lift is no switch: a decision shows a section whose caller rows all lift, an undecided caller's file keeps the gap and a person's lane, and only a decision that read nothing may not show a section", async () => {
  const slices = slicesOf(await indexOf());
  const on = evidenceOf(slices);
  const f = sectionOf("a.ts", "f").key;
  const h = sectionOf("a.ts", "h").key;
  expect("lift" in on).toBe(false);
  expect([stateOf(on, f), stateOf(on, h)]).toEqual(["shown", "shown"]);
  expect(decided(plan, on)(f)).toEqual({
    gap: false,
    lane: "static-automation",
  });
  const callerOf = (evidence: GroupEvidence, key: string) =>
    evidence.sections
      .find((s) => s.key === key)!
      .rows.find((r) => r.kind === "caller")!;
  // g's file (b.ts) undecided: h, which only g calls, keeps the gap, its row marked; f is still
  // shown, by mm's call from a settled file, which is tried first.
  const one = evidenceOf(
    slices,
    plan,
    undefined,
    lineAt,
    hunks,
    new Set(["b.ts"]),
  );
  expect([stateOf(one, f), stateOf(one, h)]).toEqual(["shown", "partial"]);
  expect(callerOf(one, f)).toMatchObject({ path: "m.ts" });
  expect(callerOf(one, f).undecided).toBeUndefined();
  expect(callerOf(one, h)).toMatchObject({ path: "b.ts", undecided: true });
  // Both callers' files undecided: both keep the gap, their rows marked, and nothing else moves.
  const held = evidenceOf(
    slices,
    plan,
    undefined,
    lineAt,
    hunks,
    new Set(["b.ts", "m.ts"]),
  );
  expect([stateOf(held, f), stateOf(held, h)]).toEqual(["partial", "partial"]);
  for (const key of [f, h]) {
    expect(callerOf(held, key).undecided).toBe(true);
    expect(callerOf(held, key).confirmed).toBe(true);
    expect(rowLifts(callerOf(held, key))).toBe(false);
  }
  expect(decided(plan, held)(f)).toEqual({
    gap: true,
    lane: "human-suggested",
  });
  expect(decided(plan, held)(h)).toEqual({
    gap: true,
    lane: "human-suggested",
  });
  // Every other section keeps its state; a row of b.ts anywhere is marked, and nothing else moves.
  const unmarked = (rows: GroupEvidence["sections"][number]["rows"]) =>
    rows.map(({ undecided: _undecided, ...row }) => row);
  for (const section of on.sections) {
    const other = held.sections.find((s) => s.key === section.key)!;
    if (section.key !== f && section.key !== h)
      expect(other.relations).toBe(section.relations);
    expect(unmarked(other.rows)).toEqual(unmarked(section.rows));
    for (const row of other.rows)
      expect(row.undecided).toBe(
        row.kind === "caller" && row.path === "b.ts" ? true : undefined,
      );
  }
  expect(GroupEvidenceSchema.safeParse(on).success).toBe(true);
  expect(GroupEvidenceSchema.safeParse(held).success).toBe(true);
  expect(
    GroupEvidenceSchema.safeParse({ ...on, outcome: "failed" }).success,
  ).toBe(false);
  // A stored decision of the round before (with its `lift`) is refused.
  expect(
    GroupEvidenceSchema.safeParse({
      ...on,
      recipe: "neuve-reading-evidence-v12",
      lift: true,
    }).success,
  ).toBe(false);
});

// Reason (round 9): what a row shows must be what the reading says it shows, and a test row must be
// read as context only.
test("the reading says per row what its line shows: called here, used here, called from a function with its first line or with none; a test row is context, and the legend says so", async () => {
  // f: g's call shown as a call; h: g's site marked a name handed over; mm's call to f marked as
  // only its caller; and a file-level test caller of f with no line.
  const base = await indexOf();
  const index = withShows(base, ({ at }) => {
    const target = base.strings[base.edges.target[at]!];
    const source = base.edges.sourceSymbol[at]!;
    const from = source === -1 ? null : base.strings[source];
    return target === "h" && from === "g" ? "reference" : undefined;
  });
  const evidence = evidenceOf(slicesOf(index));
  const reading = renderReading(plan, group.id, {
    for: "assess",
    hunks,
    structures: structures(),
    evidence,
  });
  const rows = reading.text
    .split("\n")
    .filter((line) => /^(caller|test) of /.test(line));
  expect(rows).toContain(
    `caller of f, called here: b.ts line 2\t${lineAt("b.ts", 2)!.trim()}`,
  );
  expect(rows).toContain(
    `caller of h, used here: b.ts line 3\t${lineAt("b.ts", 3)!.trim()}`,
  );
  expect(
    rows.some((row) =>
      row.startsWith(
        "test of f, called here: tests/b.test.ts line 3\texpect(f(1",
      ),
    ),
  ).toBe(true);
  // h's only trusted caller row is a name handed over, which lifts as a call does (round 13).
  expect(stateOf(evidence, sectionOf("a.ts", "h").key)).toBe("shown");
  expect(stateOf(evidence, sectionOf("a.ts", "f").key)).toBe("shown");
  // The legend: what a row is, each shown kind, and the test row's context line.
  expect(reading.text).toContain(EVIDENCE_LEGEND.rows);
  expect(reading.text).toContain(EVIDENCE_LEGEND.call);
  expect(reading.text).toContain(EVIDENCE_LEGEND.reference);
  expect(reading.text).toContain(EVIDENCE_LEGEND.tests);
  expect(EVIDENCE_LEGEND.tests).toContain(
    "a test names this; that proves nothing about what it catches",
  );
  // A row that shows only its caller: its function and that function's first line, or no line.
  const callerOnly = withShows(base, () => "caller");
  const only = evidenceOf(slicesOf(callerOnly));
  const text = renderReading(plan, group.id, {
    for: "lane-review",
    hunks,
    structures: structures(),
    evidence: only,
  }).text;
  const lines = text
    .split("\n")
    .filter((line) => /^(caller|test) of /.test(line));
  expect(lines).toContain(
    `caller of f, called from g: b.ts line 2\t${lineAt("b.ts", 2)!.trim()}`,
  );
  expect(text).toContain(EVIDENCE_LEGEND.caller);
  expect(text).not.toContain(EVIDENCE_LEGEND.call);
  expect(only.sections.some((s) => s.relations === "shown")).toBe(false);
  const lineless = evidenceOf(
    slicesOf(
      await indexOf({
        calls: [
          ...CALLS.filter((c) => c.to !== "f"),
          { from: "g", to: "f", line: null },
          { from: "file:tests/a.test.ts", to: "f", line: null },
        ],
      }),
    ),
  );
  const none = renderReading(plan, group.id, {
    for: "assess",
    hunks,
    structures: structures(),
    evidence: lineless,
  })
    .text.split("\n")
    .filter((line) => /^(caller|test) of f/.test(line));
  expect(none).toEqual([
    "caller of f, called from g: b.ts",
    "test of f, called from outside any function: tests/a.test.ts",
  ]);
  // Never a word from silence.
  for (const t of [reading.text, text])
    for (const word of ["no callers", "unused", "untested"])
      expect(t.toLowerCase()).not.toContain(word);
});

// Reason: an unsupported match shown as a caller is wrong 33 times in 36.
test("the reading holds exactly the capped rows, from the head commit, nothing for a symbol with no evidence, and never a name match", async () => {
  const evidence = evidenceOf(slicesOf(await indexOf()));
  const sources = { hunks, structures: structures() };
  const reading = renderReading(plan, group.id, {
    for: "assess",
    ...sources,
    evidence,
  });
  const rows = reading.text
    .split("\n")
    .filter((line) => /^(caller|test) of /.test(line));
  const clipped = LONG.trim().slice(0, ROW_TEXT);
  expect(rows).toEqual([
    // f: the first caller outside tests by the slice's order, and the first test file whose site
    // shows a call (tests/a.test.ts, first by path, has no line, so it is tried after).
    "caller of f, called here: b.ts line 2\texport const g = () => f(1);",
    `test of f, called here: tests/b.test.ts line 3\t${clipped}`,
    // h: its one supported caller; the name match from z.ts is never a row.
    "caller of h, called here: b.ts line 3\tconst k = () => h(2);",
    // box: its first three innermost symbols, each a caller and a test row.
    ...["dd", "c", "b"].flatMap((name) => [
      `caller of ${name}, called here: b.ts line 2\texport const g = () => f(1);`,
      `test of ${name}, called here: tests/a.test.ts line 7\ttest("box", () => box());`,
    ]),
  ]);
  expect(clipped.length).toBe(ROW_TEXT);
  expect(reading.text).not.toContain("z.ts");
  expect(reading.text).not.toMatch(/of q:|of a:/);
  // Each row sits in its own section, after that section's diff, inside its file's data block.
  const fAt = reading.text.indexOf("caller of f,");
  expect(
    reading.text
      .slice(reading.text.lastIndexOf("Section ", fAt))
      .split("\n")[0],
  ).toMatch(/^Section \d+: declaration f$/);
  // The legend says what a row is and that it cannot be cited, only when a row is shown; the
  // system prompts say what a row shows and what it never shows.
  expect(reading.text).toContain('A line "caller of <name>, ..."');
  const plain = renderReading(plan, group.id, { for: "assess", ...sources });
  const empty = renderReading(plan, group.id, {
    for: "assess",
    ...sources,
    evidence: evidenceOf(null),
  });
  expect(empty.text).toBe(plain.text);
  expect(plain.text).not.toContain("caller of");
  expect(assessStep({ stage: "verify", reading }).spec.system).toContain(
    CALLER_ROWS,
  );
  // No word that turns no row into "unused", "untested" or "no callers".
  expect(CALLER_ROWS).not.toMatch(/unused|untested|no callers|safe/);
  // A re-read shows its own sections' rows and no other's.
  const reread = renderReading(plan, group.id, {
    for: "lane-review",
    ...sources,
    only: [sectionOf("a.ts", "h").key],
    evidence,
  });
  expect(
    reread.text.split("\n").filter((line) => /^(caller|test) of /.test(line)),
  ).toEqual(["caller of h, called here: b.ts line 3\tconst k = () => h(2);"]);
  // Another group's evidence is refused.
  expect(() =>
    renderReading(plan, group.id, {
      for: "assess",
      ...sources,
      evidence: { ...evidence, group: "rg_other" },
    }),
  ).toThrow("is not group");
});

// ---------------------------------------------------------------------------------------------
// Round 6c: pure removals, and the bound on the call sites tried
// ---------------------------------------------------------------------------------------------

type XSym = Readonly<{ id: string; start: number; end: number }>;

/** One of Graph's symbols as a stored structure holds it, by its lines. */
type GSym = Readonly<{
  name: string;
  kind: string;
  container: string | null;
  start: number;
  end: number;
}>;

/** A structure whose spans hold the given symbols, each in the span it starts in. */
const withSymbols = (
  structure: ReturnType<typeof symbolStructure>,
  symbols: ReadonlyArray<GSym> | undefined,
): ReturnType<typeof symbolStructure> =>
  symbols === undefined
    ? structure
    : {
        ...structure,
        spans: structure.spans.map((span) => ({
          ...span,
          symbols: symbols
            .filter((s) => s.start >= span.start && s.start <= span.end)
            .sort((a, b) => a.start - b.start)
            .map((s) => ({
              name: s.name,
              kind: s.kind,
              qualifiedName:
                s.container === null ? s.name : `${s.container}.${s.name}`,
              signature: null,
              container: s.container,
              startLine: s.start,
              endLine: s.end,
            })),
        })),
      };

/** A class `Box` over lines 1 to `end`, and its methods, each `[name, start, end]`. */
const boxGraph = (
  end: number,
  methods: ReadonlyArray<readonly [string, number, number]>,
): Array<GSym> => [
  { name: "Box", kind: "class", container: null, start: 1, end },
  ...methods.map(([name, start, stop]) => ({
    name,
    kind: "method",
    container: "Box",
    start,
    end: stop,
  })),
];
type XCall = Readonly<{
  from: string;
  to: string;
  path: string;
  line: number;
  /** Graph's resolution of the call; `exact` (resolved) when absent. */
  resolution?: string;
}>;

/**
 * One changed file `x.ts` read as one section spanning it, its head index holding the given
 * symbols of `x.ts`, a caller `g` in `b.ts`, thirty more callers `c1` to `c30` in `p1.ts` to
 * `p30.ts`, and the given calls; tests are the files under `tests/`.
 */
const xCase = async (
  before: string,
  after: string,
  symbols: ReadonlyArray<XSym>,
  calls: ReadonlyArray<XCall>,
  files: Readonly<Record<string, string>>,
  /** The structure's spans on each side; one declaration spanning the file when absent. */
  spans?: {
    readonly before: Parameters<typeof symbolStructure>[1];
    readonly after: Parameters<typeof symbolStructure>[1];
  },
  /**
   * Graph's symbols in the stored structure on each side, with their real lines, in place of the
   * one symbol per span the fixture gives; each goes to the span it starts in.
   */
  graph?: {
    readonly before: ReadonlyArray<GSym>;
    readonly after: ReadonlyArray<GSym>;
  },
  /** File-to-file imports at the head, `[importing, imported]`: what backs a match by name. */
  imports: ReadonlyArray<readonly [string, string]> = [],
) => {
  const xHunks = diff("x.ts", before, after);
  const map = new Map(xHunks.map((hunk) => [hunk.hunkId, hunk]));
  const lines = (text: string) => text.split("\n").length - 1;
  const xPlan = planReadings({
    hunks: xHunks,
    structures: new Map(
      [before, after].map((text) => [
        oidOf(text),
        withSymbols(
          symbolStructure(
            text,
            spans === undefined
              ? [
                  {
                    start: 1,
                    end: lines(text),
                    kind: "declaration",
                    name: "Top",
                  },
                ]
              : text === before
                ? spans.before
                : spans.after,
          ),
          graph === undefined
            ? undefined
            : text === before
              ? graph.before
              : graph.after,
        ),
      ]),
    ),
  });
  const builder = new RelationsIndexBuilder();
  const numbers = Array.from({ length: 30 }, (_, at) => at + 1);
  const others = ["b.ts", ...numbers.map((n) => `p${n}.ts`)];
  for (const path of ["x.ts", ...others, "tests/t.test.ts"])
    builder.file({
      id: `file:${path}`,
      path,
      language: "TypeScript",
      bytes: 1,
    });
  const all = [
    ...symbols.map((symbol) => ({ ...symbol, path: "x.ts" })),
    { id: "g", path: "b.ts", start: 1, end: 9 },
    ...numbers.map((n) => ({
      id: `c${n}`,
      path: `p${n}.ts`,
      start: 1,
      end: 9,
    })),
  ];
  for (const symbol of all)
    builder.symbol({
      id: symbol.id,
      name: symbol.id,
      qualifiedName: symbol.id,
      kind: "function",
      language: "TypeScript",
      path: symbol.path,
      startLine: symbol.start,
      endLine: symbol.end,
      containerId: null,
      signature: null,
    });
  for (const call of calls)
    builder.relation({
      relation: "CALLS",
      fromId: call.from,
      toId: call.to,
      targetKind: "symbol",
      resolution: call.resolution ?? "exact",
      confidence: 0.8,
      scope: null,
      evidence: [
        {
          kind: "call_site",
          location: {
            kind: "point",
            path: call.path as SourcePath,
            line: call.line,
          },
          detail: null,
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
  for (const [from, to] of imports)
    builder.relation({
      relation: "IMPORTS",
      fromId: `file:${from}`,
      toId: `file:${to}`,
      targetKind: "file",
      resolution: "import_resolved",
      confidence: 0.9,
      scope: "module",
      evidence: [],
      warningCodes: [],
      evidenceDropped: 0,
    });
  const slices = slicesOf(
    futureShape(await builder.finish(coverage())),
    xPlan,
    map,
  );
  const asked: Array<string> = [];
  const at = (path: string, line: number) => {
    asked.push(path);
    return files[path]?.split("\n")[line - 1] ?? null;
  };
  const evidence = evidenceOf(slices, xPlan, undefined, at, map);
  const section = xPlan.sections[0]!;
  if (spans === undefined) expect(xPlan.sections).toHaveLength(1);
  /** One section of the case by its name: its state, its rows and whether it keeps its gap. */
  const byName = (name: string) => {
    const key = xPlan.sections.find((s) => s.name === name)!.key;
    const entry = evidence.sections.find((s) => s.key === key)!;
    return {
      section: xPlan.sections.find((s) => s.name === name)!,
      state: entry.relations,
      rows: entry.rows.map((r) => `${r.kind} of ${r.symbol}`),
      gap: decidedX(xPlan, map, evidence, key),
    };
  };
  return {
    byName,
    evidence,
    lane: laneX(xPlan, map, evidence),
    plan: xPlan,
    map,
    slices,
    section,
    asked,
    state: evidence.sections[0]!.relations,
    rows: evidence.sections[0]!.rows.map((r) => `${r.kind} of ${r.symbol}`),
    gap: decidedX(xPlan, map, evidence),
  };
};

/** Whether the one section of a case keeps its relations gap, decided as `decided` does. */
const decisionX = (
  of: ReadingPlan,
  map: typeof hunks,
  evidence: GroupEvidence,
  key = of.sections[0]!.key,
) => {
  const section = of.sections.find((s) => s.key === key)!;
  const { sections } = decideSections({
    plan: of,
    hunks: map,
    groups: [],
    collected: new Map(
      of.sections.map((each) => [
        each.key,
        {
          assess: {
            judged: true,
            judgement: judgementFor("static-automation"),
          },
          review: {
            judged: true,
            judgement: {
              verdict: "approve",
              comments: [],
              checked: "",
              rows: [],
              unsure: [],
            },
          },
          claims: [],
          steps: { assess: "a".repeat(64), review: "b".repeat(64) },
        },
      ]),
    ),
    proofs: new Map([[section.path, RECORDS]]),
    findings: [],
    excluded: [],
    relations: new Set(
      evidence.sections
        .filter((s) => s.relations === "shown")
        .map((s) => s.key),
    ),
  });
  const decision = sections.find((s) => s.section.key === key)!.decision!;
  if (!decision.settled) throw new Error("not settled");
  return decision;
};

/** Whether the one section of a case keeps its relations gap. */
const decidedX = (...args: Parameters<typeof decisionX>) =>
  decisionX(...args).entry.assess!.gaps.some(
    (gap) => gap.kind === RELATIONS_GAP.kind,
  );

/** The lane the rule gives the one section of a case. */
const laneX = (...args: Parameters<typeof decisionX>) =>
  decisionX(...args).entry.lane.applied;

const X_FILES = {
  "b.ts":
    "import { x } from './x';\nconst one = x.open(1);\nconst two = x.close(2);\nconst three = x.f(3);\n",
  "tests/t.test.ts":
    "import { x } from '../x';\ntest('o', () => x.open());\ntest('c', () => x.close());\ntest('f', () => x.f());\n",
  "p6.ts": "export const c6 = () => x.f(6);\n",
};
/** A symbol's caller in `b.ts` and its test call, both at `line`. */
const covered = (to: string, line: number): Array<XCall> => [
  { from: "g", to, path: "b.ts", line },
  { from: "file:tests/t.test.ts", to, path: "tests/t.test.ts", line },
];

// Reason (round 6c): deleting a check is the change where who calls the code matters most, so a
// line removed inside a symbol needs that symbol's evidence at the head, as a changed line does.
test("a pure removal needs the evidence of the symbol it sat in at the head; between two symbols, at the file's start, or where its symbol is gone, the gap stays", async () => {
  // N1: class Box; open loses its guard line and gains nothing; close changes one line and is
  // covered. The removal sits between head lines 2 and 3, both in open.
  const N1_BEFORE =
    "export class Box {\n  open(k) {\n    if (!k) throw new Error('no key');\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const N1_AFTER =
    "export class Box {\n  open(k) {\n    return 1;\n  }\n  close() {\n    return 2;\n  }\n}\n";
  // Graph's symbols with their lines on each side: the guard was open's, the changed line close's.
  const N1_GRAPH = {
    before: boxGraph(9, [
      ["open", 2, 5],
      ["close", 6, 8],
    ]),
    after: boxGraph(8, [
      ["open", 2, 4],
      ["close", 5, 7],
    ]),
  };
  const boxSymbols = [
    { id: "Box", start: 1, end: 8 },
    { id: "open", start: 2, end: 4 },
    { id: "close", start: 5, end: 7 },
  ];
  const n1 = await xCase(
    N1_BEFORE,
    N1_AFTER,
    boxSymbols,
    covered("close", 3),
    X_FILES,
    undefined,
    N1_GRAPH,
  );
  expect(removalPlaces(n1.section, n1.map)).toEqual({
    places: [{ path: "x.ts", line: 2 }],
    undetermined: false,
  });
  expect(n1.state).toBe("partial");
  expect(n1.rows).toEqual(["caller of close", "test of close"]);
  expect(n1.gap).toBe(true);
  // The same with open covered too: shown, the gap gone. A replaced line (close's) needs nothing
  // beyond its own symbol.
  const both = await xCase(
    N1_BEFORE,
    N1_AFTER,
    boxSymbols,
    [...covered("close", 3), ...covered("open", 2)],
    X_FILES,
    undefined,
    N1_GRAPH,
  );
  expect(both.state).toBe("shown");
  expect(both.rows.sort()).toEqual([
    "caller of close",
    "caller of open",
    "test of close",
    "test of open",
  ]);
  expect(both.gap).toBe(false);

  // A line removed between two symbols (f ends at head line 3, k starts at 4), f's body changed:
  // no symbol encloses the place, so the gap stays though f and k are both covered.
  const between = await xCase(
    "export function f() {\n  return 1;\n}\nconst z = 1;\nexport function k() {\n  return 1;\n}\n",
    "export function f() {\n  return 2;\n}\nexport function k() {\n  return 1;\n}\n",
    [
      { id: "f", start: 1, end: 3 },
      { id: "k", start: 4, end: 6 },
    ],
    [...covered("f", 4), ...covered("k", 2)],
    X_FILES,
  );
  expect(removalPlaces(between.section, between.map).places).toEqual([
    { path: "x.ts", line: 3 },
  ]);
  expect(between.state).toBe("partial");
  expect(between.gap).toBe(true);

  // A removal at the file's start: no head line before it, so its place cannot be told.
  const start = await xCase(
    "// header\nexport function f() {\n  return 1;\n}\n",
    "export function f() {\n  return 2;\n}\n",
    [{ id: "f", start: 1, end: 3 }],
    covered("f", 4),
    X_FILES,
  );
  expect(removalPlaces(start.section, start.map)).toEqual({
    places: [],
    undetermined: true,
  });
  expect(start.rows).toEqual(["caller of f", "test of f"]);
  expect(start.state).toBe("partial");
  expect(start.gap).toBe(true);

  // A symbol removed whole (gone) between f and h, h's body changed: nothing at the head encloses
  // where gone was, so the gap stays though f and h are both covered.
  const gone = await xCase(
    "export function f() {\n  return 1;\n}\nexport function gone() {\n  return 9;\n}\nexport function h() {\n  const a = 1;\n  return a;\n}\n",
    "export function f() {\n  return 1;\n}\nexport function h() {\n  const a = 2;\n  return a;\n}\n",
    [
      { id: "f", start: 1, end: 3 },
      { id: "h", start: 4, end: 7 },
    ],
    [...covered("f", 4), ...covered("h", 2)],
    X_FILES,
  );
  expect(removalPlaces(gone.section, gone.map).places).toEqual([
    { path: "x.ts", line: 3 },
  ]);
  expect(gone.state).toBe("partial");
  expect(gone.gap).toBe(true);
});

/**
 * The diff merges a removed function into the replacement block of the function before it: `f`'s
 * body changes, and `gone` is removed whole. Read with one section per declaration, as the
 * structure gives top-level functions.
 */
const mergedCase = () =>
  xCase(
    "export function f() {\n  return 1;\n}\nexport function gone() {\n  return 9;\n}\nexport function h() {\n  return 1;\n}\n",
    "export function f() {\n  return 2;\n}\nexport function h() {\n  return 1;\n}\n",
    [
      { id: "f", start: 1, end: 3 },
      { id: "h", start: 4, end: 6 },
    ],
    [...covered("f", 4), ...covered("h", 2)],
    X_FILES,
    {
      before: [
        { start: 1, end: 3, kind: "declaration", name: "f" },
        { start: 4, end: 6, kind: "declaration", name: "gone" },
        { start: 7, end: 9, kind: "declaration", name: "h" },
      ],
      after: [
        { start: 1, end: 3, kind: "declaration", name: "f" },
        { start: 4, end: 6, kind: "declaration", name: "h" },
      ],
    },
  );

// Reason (round 6c, addition): a removed declaration's callers are on the base side, which is not
// read, so a removal the diff merges into another symbol's replacement block must not lose its gap.
// Decided by two rules at once: `gone`'s section adds no line (decision 4), and the plan does not
// know that its span lost no symbol (`symbolRemoved` null: the declaration is not on both sides).
test("a declaration removed inside a merged replacement block keeps its gap; the function whose lines the block replaces is judged on its own", async () => {
  const merged = await mergedCase();
  const gone = merged.byName("gone");
  expect(gone.section.symbolRemoved).toBeNull();
  expect(gone.section.owned.every((range) => range.side === "old")).toBe(true);
  // No evidence shown at the head stands for a removed declaration's callers. Its removal sits
  // between head lines 1 and 2, both in f, and f has both rows: shown in part, never whole.
  expect(gone.rows).toEqual(["caller of f", "test of f"]);
  expect(gone.state).toBe("partial");
  expect(gone.gap).toBe(true);
  // f still exists at the head and lost no symbol; its replaced lines need its own evidence,
  // which it has.
  const f = merged.byName("f");
  expect(f.section.symbolRemoved).toBe(false);
  expect(f.state).toBe("shown");
  expect(f.gap).toBe(false);
});

/** A class read as one section, its head symbols `Box` (1-5) and the method at lines 2-4. */
const classCase = (
  before: string,
  after: string,
  graph: {
    readonly before: ReadonlyArray<GSym>;
    readonly after: ReadonlyArray<GSym>;
  },
  method: string,
  calls: ReadonlyArray<XCall> = covered(method, 2),
) =>
  xCase(
    before,
    after,
    [
      { id: "Box", start: 1, end: after.split("\n").length - 1 },
      ...graph.after
        .filter((symbol) => symbol.container === "Box")
        .map((symbol) => ({
          id: symbol.name,
          start: symbol.start,
          end: symbol.end,
        })),
    ],
    calls,
    X_FILES,
    {
      before: [
        {
          start: 1,
          end: before.split("\n").length - 1,
          kind: "declaration",
          name: "Box",
        },
      ],
      after: [
        {
          start: 1,
          end: after.split("\n").length - 1,
          kind: "declaration",
          name: "Box",
        },
      ],
    },
    graph,
  );
const BOX_WITH_GONE =
  "export class Box {\n  open() {\n    return 1;\n  }\n  gone() {\n    return 9;\n  }\n}\n";
const BOX_OPEN_1 = "export class Box {\n  open() {\n    return 1;\n  }\n}\n";
const BOX_OPEN_2 = "export class Box {\n  open() {\n    return 2;\n  }\n}\n";

// Reason (round 6c, second addition): a method removed inside a class section, which the diff merges
// into the kept method's replacement block, has its callers on the base side; the kept method's
// evidence must not stand for them.
test("a method removed inside a class section, merged into the kept method's replacement block, keeps the gap though the kept method is covered; without a removed symbol the class is shown", async () => {
  const removed = await classCase(
    BOX_WITH_GONE,
    BOX_OPEN_2,
    {
      before: boxGraph(8, [
        ["open", 2, 4],
        ["gone", 5, 7],
      ]),
      after: boxGraph(5, [["open", 2, 4]]),
    },
    "open",
  );
  // The diff merges gone's lines into open's replacement: no pure removal, no place.
  expect(removalPlaces(removed.section, removed.map)).toEqual({
    places: [],
    undetermined: false,
  });
  expect(removed.section.symbolRemoved).toBe(true);
  expect(removed.rows).toEqual(["caller of open", "test of open"]);
  expect(removed.state).toBe("partial");
  expect(removed.gap).toBe(true);
  // The same class, its method changed and no symbol removed: shown, the gap gone.
  const plain = await classCase(
    BOX_OPEN_1,
    BOX_OPEN_2,
    {
      before: boxGraph(5, [["open", 2, 4]]),
      after: boxGraph(5, [["open", 2, 4]]),
    },
    "open",
  );
  expect(plain.section.symbolRemoved).toBe(false);
  expect(plain.state).toBe("shown");
  expect(plain.gap).toBe(false);
});

// Reason (round 6c, second addition): a renamed method is a removed name, whose callers at the base
// are not read.
test("a method renamed inside a class keeps the gap though the new name is covered", async () => {
  const renamed = await classCase(
    BOX_OPEN_1,
    "export class Box {\n  shut() {\n    return 1;\n  }\n}\n",
    {
      before: boxGraph(5, [["open", 2, 4]]),
      after: boxGraph(5, [["shut", 2, 4]]),
    },
    "shut",
  );
  expect(renamed.section.symbolRemoved).toBe(true);
  expect(renamed.rows).toEqual(["caller of shut", "test of shut"]);
  expect(renamed.state).toBe("partial");
  expect(renamed.gap).toBe(true);
});

// Reason (round 6c, second addition): where the plan could not tell whether a symbol was removed,
// that must never read as "none removed".
test("with the section facts not computable the plan holds no symbolRemoved, and the gap stays", async () => {
  const plain = await classCase(
    BOX_OPEN_1,
    BOX_OPEN_2,
    {
      before: boxGraph(5, [["open", 2, 4]]),
      after: boxGraph(5, [["open", 2, 4]]),
    },
    "open",
  );
  expect(plain.state).toBe("shown");
  // The plan as `planReadings` gives it when `sectionFactsOf` throws: no facts, no value.
  expect(symbolRemovedOf(undefined, undefined, plain.section.owned)).toBeNull();
  const unknown: ReadingPlan = {
    ...plain.plan,
    sections: plain.plan.sections.map((s) => ({
      ...s,
      facts: [],
      symbolRemoved: null,
    })),
  };
  const evidence = evidenceOf(
    plain.slices,
    unknown,
    undefined,
    (path, line) =>
      X_FILES[path as keyof typeof X_FILES]?.split("\n")[line - 1] ?? null,
    plain.map,
  );
  expect(evidence.sections[0]!.relations).toBe("partial");
  expect(evidence.sections[0]!.rows).toHaveLength(2);
  expect(decidedX(unknown, plain.map, evidence)).toBe(true);
});

// Reason (round 6c, second addition): the plan's field must take each of its three values from the
// sections lane's fact values, never a default.
test("the plan says a span lost a symbol as true, false or null, from the facts' values", async () => {
  const range = mixedRange();
  const mixed = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const by = (path: string, name: string | null) =>
    [...mixed.sections, ...mixed.unread].find(
      (s) => s.path === path && s.name === name,
    )!.symbolRemoved;
  // A declaration on both sides that lost no symbol: `symbols-removed` names none.
  expect(by("src/parse.ts", "helper")).toBe(false);
  // An added declaration: the fact is not known (no counterpart), the declaration fact says
  // `added`, and the section owns no old line: there was nothing to lose.
  expect(by("src/parse.ts", "count")).toBe(false);
  // A removed declaration: not known.
  expect(by("src/old.ts", "drop")).toBeNull();
  // A file with no structure (a section with no span): not known.
  expect(
    mixed.sections.find((s) => s.path === "notes.txt")!.symbolRemoved,
  ).toBeNull();
  // A span that lost a symbol: true.
  const removed = await classCase(
    BOX_WITH_GONE,
    BOX_OPEN_2,
    {
      before: boxGraph(8, [
        ["open", 2, 4],
        ["gone", 5, 7],
      ]),
      after: boxGraph(5, [["open", 2, 4]]),
    },
    "open",
  );
  expect(removed.section.symbolRemoved).toBe(true);
  // Every value is one of the three, on every section, read or not.
  for (const section of [...mixed.sections, ...mixed.unread])
    expect([true, false, null]).toContain(section.symbolRemoved);
});

// ---------------------------------------------------------------------------------------------
// Round 6d: every removed row attributed to its base symbol and that symbol's head match
// ---------------------------------------------------------------------------------------------

/** One class section's case with Graph's symbols on each side and the given calls. */
const boxCase = (
  before: string,
  after: string,
  graph: {
    readonly before: ReadonlyArray<GSym>;
    readonly after: ReadonlyArray<GSym>;
  },
  calls: ReadonlyArray<XCall>,
  index?: ReadonlyArray<XSym>,
) =>
  xCase(
    before,
    after,
    index ??
      graph.after.map((symbol) => ({
        id: symbol.name,
        start: symbol.start,
        end: symbol.end,
      })),
    calls,
    X_FILES,
    {
      before: [
        {
          start: 1,
          end: before.split("\n").length - 1,
          kind: "declaration",
          name: "Box",
        },
      ],
      after: [
        {
          start: 1,
          end: after.split("\n").length - 1,
          kind: "declaration",
          name: "Box",
        },
      ],
    },
    graph,
  );

// Reason (round 6d, R9): a removed line merged by the diff into the next symbol's replacement block
// belonged to the symbol before; its evidence must be required, or a person's work moves on the
// next symbol's callers alone.
test("R9: a chained line removed from one member, merged into the next member's replacement, needs the first member's rows", async () => {
  const before =
    "export class Box {\n  open = () => this.a()\n    .then(guard)\n  close = () => this.b(1)\n}\n";
  const after =
    "export class Box {\n  open = () => this.a()\n  close = () => this.b(2)\n}\n";
  const graph = {
    before: boxGraph(5, [
      ["open", 2, 3],
      ["close", 4, 4],
    ]),
    after: boxGraph(4, [
      ["open", 2, 2],
      ["close", 3, 3],
    ]),
  };
  const only = await boxCase(before, after, graph, covered("close", 3));
  // One block of two removed rows and one added: no removal place.
  expect(removalPlaces(only.section, only.map).places).toEqual([]);
  expect(only.section.removedAttributed).toBe(true);
  expect(only.section.removedHeads).toEqual([
    { startLine: 2, endLine: 2 },
    { startLine: 3, endLine: 3 },
  ]);
  expect(only.rows).toEqual(["caller of close", "test of close"]);
  expect(only.state).toBe("partial");
  expect(only.gap).toBe(true);
  const both = await boxCase(before, after, graph, [
    ...covered("close", 3),
    ...covered("open", 2),
  ]);
  expect(both.state).toBe("shown");
  expect(both.gap).toBe(false);
});

// Reason (round 6d, E2): a removed class-body line that is no symbol of its own belonged to the
// class; the class's evidence is what speaks for it.
test("E2: a class-body line removed above a changed method needs the class's own rows", async () => {
  const before =
    "export class Box {\n  static { register(Box); }\n  close() {\n    return 1;\n  }\n}\n";
  const after = "export class Box {\n  close(force) {\n    return 1;\n  }\n}\n";
  const graph = {
    before: boxGraph(6, [["close", 3, 5]]),
    after: boxGraph(5, [["close", 2, 4]]),
  };
  const only = await boxCase(before, after, graph, covered("close", 3));
  expect(removalPlaces(only.section, only.map).places).toEqual([]);
  expect(only.section.removedHeads).toEqual([
    { startLine: 1, endLine: 5 },
    { startLine: 2, endLine: 4 },
  ]);
  expect(only.state).toBe("partial");
  expect(only.gap).toBe(true);
  const classToo = await boxCase(before, after, graph, [
    ...covered("close", 3),
    ...covered("Box", 4),
  ]);
  // Round 6f leaves this as it was: the removed `static` line lies inside the class symbol's own
  // lines (1-6), so it is the class's, not a row no symbol takes in.
  expect(classToo.section.removedAttributed).toBe(true);
  expect(classToo.state).toBe("shown");
  expect(classToo.gap).toBe(false);
});

// Reason (round 6f): a removed row no symbol takes in must keep the gap, as a changed head line
// inside no symbol does; the two rules must agree.
test("a removed row the span holds but no symbol takes in is not attributed; a symbol's own first and last lines are its own", async () => {
  const declared = (
    before: string,
    after: string,
    span: { before: number; after: number },
    lines: { before: [number, number]; after: [number, number] },
  ) =>
    xCase(
      before,
      after,
      [{ id: "f", start: lines.after[0], end: lines.after[1] }],
      covered("f", 4),
      X_FILES,
      {
        before: [
          { start: 1, end: span.before, kind: "declaration", name: "f" },
        ],
        after: [{ start: 1, end: span.after, kind: "declaration", name: "f" }],
      },
      {
        before: [
          {
            name: "f",
            kind: "function",
            container: null,
            start: lines.before[0],
            end: lines.before[1],
          },
        ],
        after: [
          {
            name: "f",
            kind: "function",
            container: null,
            start: lines.after[0],
            end: lines.after[1],
          },
        ],
      },
    );
  // Neuve's example: a one-line function replaced, and the comment under it, which its span still
  // holds, removed in the same block.
  const comment = await declared(
    "export const f = () => 1;\n// old note\n",
    "export const f = () => 2;\n",
    { before: 2, after: 1 },
    { before: [1, 1], after: [1, 1] },
  );
  expect(comment.section.removedAttributed).toBe(false);
  expect(comment.rows).toEqual(["caller of f", "test of f"]);
  expect(comment.state).toBe("partial");
  expect(comment.gap).toBe(true);
  // A statement that starts on f's closing line, so the span runs on past f.
  const audit = await declared(
    "export function f() {\n  return 1;\n} audit(\n  f,\n);\n",
    "export function f() {\n  return 2;\n}\n",
    { before: 5, after: 3 },
    { before: [1, 3], after: [1, 3] },
  );
  expect(audit.section.removedAttributed).toBe(false);
  expect(audit.state).toBe("partial");
  expect(audit.gap).toBe(true);
  // f's own last line replaced: f's, attributed, shown.
  const last = await declared(
    "export function f() {\n  return 1;\n}\n",
    "export function f() {\n  return 1;\n};\n",
    { before: 3, after: 3 },
    { before: [1, 3], after: [1, 3] },
  );
  expect(last.section.removedAttributed).toBe(true);
  expect(last.section.removedHeads).toEqual([{ startLine: 1, endLine: 3 }]);
  expect(last.state).toBe("shown");
  // An ordinary removed line inside a method: still attributed to that method.
  const graph5 = boxGraph(5, [["open", 2, 4]]);
  const ordinary = await boxCase(
    BOX_OPEN_1,
    BOX_OPEN_2,
    { before: graph5, after: graph5 },
    covered("open", 2),
  );
  expect(ordinary.section.removedAttributed).toBe(true);
  expect(ordinary.section.removedHeads).toEqual([{ startLine: 2, endLine: 4 }]);
  expect(ordinary.state).toBe("shown");
});

// Reason (the coordinator's rule, round 13): a lifted gap never lowers high-and-hard work. Without
// the relations gap the lane rule places high and hard at human-required; with it, cited high and
// hard stays there (10.9) and uncited high and hard goes to human-suggested, so the lift only ever
// keeps or raises such work, never lowers it.
test("a lifted gap never lowers high-and-hard work: shown or not, cited high and hard is human-required, and uncited high and hard is raised by the lift, never lowered", async () => {
  const slices = slicesOf(await indexOf());
  const shown = evidenceOf(slices);
  const held = evidenceOf(
    slices,
    plan,
    undefined,
    lineAt,
    hunks,
    new Set(["b.ts", "m.ts"]),
  );
  const f = sectionOf("a.ts", "f").key;
  expect([stateOf(shown, f), stateOf(held, f)]).toEqual(["shown", "partial"]);
  const cited = judgementFor("human-required");
  expect(cited.complexity.factors[0]!.cites.length).toBeGreaterThan(0);
  expect(decided(plan, shown, cited)(f)).toEqual({
    gap: false,
    lane: "human-required",
  });
  expect(decided(plan, held, cited)(f)).toEqual({
    gap: true,
    lane: "human-required",
  });
  const uncited = {
    ...cited,
    complexity: {
      ...cited.complexity,
      factors: cited.complexity.factors.map((one) => ({ ...one, cites: [] })),
    },
    easeOfValidation: {
      ...cited.easeOfValidation,
      requirements: cited.easeOfValidation.requirements.map((one) => ({
        ...one,
        cites: [],
      })),
    },
  };
  expect(decided(plan, shown, uncited)(f)).toEqual({
    gap: false,
    lane: "human-required",
  });
  expect(decided(plan, held, uncited)(f)).toEqual({
    gap: true,
    lane: "human-suggested",
  });
  // Every lane, shown against held: the lift never moves a section to a lower lane.
  const rank = (lane: string) =>
    [
      "static-automation",
      "agentic",
      "human-suggested",
      "human-required",
    ].indexOf(lane);
  for (const judgement of [cited, uncited])
    for (const section of plan.sections) {
      const lifted = decided(plan, shown, judgement)(section.key).lane;
      const kept = decided(plan, held, judgement)(section.key).lane;
      if (judgement.complexity.level === "high" && rank(kept) === 3)
        expect(rank(lifted)).toBe(3);
    }
});

// Reason (round 6f, defence in depth; rounds 9 and 13): a stored decision must never say `shown` on a
// caller row that does not lift, nor from a decision that read nothing, and a test row is not read
// for it either way. Stored answers must not cross shapes: a decision stored under the round before
// is refused.
test("the stored form refuses a shown section whose caller row is unconfirmed, only its caller, from an undecided file or absent, and one from a decision that read nothing; a name handed over lifts; a test row of any kind beside a lifting caller row is accepted, but never one marked undecided; a decision of the round before is refused", () => {
  const row = {
    kind: "caller" as const,
    symbol: "f",
    path: "b.ts",
    shows: "call" as const,
    line: 2 as number | null,
    text: "export const g = () => f(1);" as string | null,
    from: "g",
    confirmed: true,
  };
  const test = {
    ...row,
    kind: "test" as const,
    path: "tests/a.test.ts",
    shows: "caller" as const,
    line: null,
    text: null,
    from: null,
    confirmed: false,
  };
  const decision = (rows: ReadonlyArray<object>, outcome = "read") => ({
    recipe: EVIDENCE_RECIPE,
    group: "rg_x",
    outcome,
    relations: { head: null, base: null },
    sections: [{ key: "k", relations: "shown", rows }],
  });
  const parses = (value: unknown) =>
    GroupEvidenceSchema.safeParse(value).success;
  expect(parses(decision([row]))).toBe(true);
  // A test row, unconfirmed and lineless, beside a lifting caller row: not read for the lift.
  expect(parses(decision([row, test]))).toBe(true);
  expect(parses(decision([{ ...row, confirmed: false }]))).toBe(false);
  expect(parses(decision([{ ...row, shows: "reference" }]))).toBe(true);
  expect(parses(decision([{ ...row, undecided: true }]))).toBe(false);
  expect(
    parses({
      ...decision([]),
      sections: [
        { key: "k", relations: "partial", rows: [{ ...row, undecided: true }] },
      ],
    }),
  ).toBe(true);
  expect(parses(decision([row, { ...test, undecided: true }]))).toBe(false);
  expect(parses(decision([{ ...row, shows: "caller" }]))).toBe(false);
  expect(
    parses(decision([{ ...row, shows: "caller", line: null, text: null }])),
  ).toBe(false);
  // A test row alone, however it shows, is no caller row.
  expect(
    parses(
      decision([
        { ...test, shows: "call", line: 2, text: "x", confirmed: true },
      ]),
    ),
  ).toBe(false);
  expect(parses(decision([row], "failed"))).toBe(false);
  // A row's line and text come together, and only a `caller` row may have none.
  expect(parses(decision([{ ...row, text: null }]))).toBe(false);
  expect(
    parses({
      ...decision([]),
      sections: [
        {
          key: "k",
          relations: "partial",
          rows: [{ ...row, line: null, text: null }],
        },
      ],
    }),
  ).toBe(false);
  // The round before's stored shape: its recipe and `callLines`, rows without `shows`.
  const before = {
    recipe: "neuve-reading-evidence-v11",
    group: "rg_x",
    outcome: "read",
    callLines: false,
    relations: { head: null, base: null },
    sections: [
      {
        key: "k",
        relations: "partial",
        rows: [
          {
            kind: "caller",
            symbol: "f",
            path: "b.ts",
            line: 2,
            text: "x",
            from: "g",
            confirmed: true,
          },
        ],
      },
    ],
  };
  expect(parses(before)).toBe(false);
  expect(parses({ ...before, recipe: EVIDENCE_RECIPE })).toBe(false);
  expect(EVIDENCE_RECIPE).toBe("neuve-reading-evidence-v13");
});

// Reason (round 7, the remainder of N-l): a stored decision saying `shown` must hold the rows that
// lift the gap; the code never writes one with none, so the form refuses it.
test("the stored form refuses a shown section with no rows, and every other state still parses with none", () => {
  const decision = (relations: string) => ({
    recipe: EVIDENCE_RECIPE,
    group: "rg_x",
    outcome: "read",
    relations: { head: null, base: null },
    sections: [{ key: "k", relations, rows: [] }],
  });
  expect(GroupEvidenceSchema.safeParse(decision("shown")).success).toBe(false);
  for (const state of ["partial", "no-evidence", "over-cap", "not-read"])
    expect(GroupEvidenceSchema.safeParse(decision(state)).success).toBe(true);
});

// Reason (round 6d): attribution must add nothing where the removed rows are the changed symbol's
// own, and must not take in a neighbour, which a rule over "the lines either side of every merged
// block" would have.
test("an ordinary replacement and a replaced signature line require their own symbol only, not a neighbour", async () => {
  const graph5 = boxGraph(5, [["open", 2, 4]]);
  const ordinary = await boxCase(
    BOX_OPEN_1,
    BOX_OPEN_2,
    { before: graph5, after: graph5 },
    covered("open", 2),
  );
  expect(ordinary.section.removedHeads).toEqual([{ startLine: 2, endLine: 4 }]);
  expect(ordinary.rows).toEqual(["caller of open", "test of open"]);
  expect(ordinary.state).toBe("shown");
  const twoMethods = boxGraph(8, [
    ["open", 2, 4],
    ["close", 5, 7],
  ]);
  const signature = await boxCase(
    "export class Box {\n  open() {\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n",
    "export class Box {\n  open() {\n    return 1;\n  }\n  close(x) {\n    return 1;\n  }\n}\n",
    { before: twoMethods, after: twoMethods },
    covered("close", 3),
  );
  expect(signature.section.removedHeads).toEqual([
    { startLine: 5, endLine: 7 },
  ]);
  // open, the line before, is not required: close alone is shown whole.
  expect(signature.rows).toEqual(["caller of close", "test of close"]);
  expect(signature.state).toBe("shown");
  expect(signature.gap).toBe(false);
});

// Reason (round 6d): a removed row the plan cannot place in a symbol must keep the gap, never be
// dropped from the rule.
test("a removed top-level statement merged into a replacement, a span with no symbols, and no base structure keep the gap", async () => {
  // `const z` sits in no symbol of the file's span, directly above k's changed signature.
  const statement = await xCase(
    "export function f() {\n  return 1;\n}\nconst z = 1;\nexport function k(a) {\n  return 1;\n}\n",
    "export function f() {\n  return 1;\n}\nexport function k(a, b) {\n  return 1;\n}\n",
    [
      { id: "f", start: 1, end: 3 },
      { id: "k", start: 4, end: 6 },
    ],
    [...covered("f", 4), ...covered("k", 2)],
    X_FILES,
    undefined,
    {
      before: [
        { name: "f", kind: "function", container: null, start: 1, end: 3 },
        { name: "k", kind: "function", container: null, start: 5, end: 7 },
      ],
      after: [
        { name: "f", kind: "function", container: null, start: 1, end: 3 },
        { name: "k", kind: "function", container: null, start: 4, end: 6 },
      ],
    },
  );
  expect(removalPlaces(statement.section, statement.map).places).toEqual([]);
  expect(statement.section.removedAttributed).toBe(false);
  expect(statement.section.removedHeads).toEqual([]);
  expect(statement.state).toBe("partial");
  expect(statement.gap).toBe(true);
  // A language Graph gives spans but no symbols for: nothing to attribute to.
  const bare = await xCase(
    "export function f() {\n  return 1;\n}\n",
    "export function f() {\n  return 2;\n}\n",
    [{ id: "f", start: 1, end: 3 }],
    covered("f", 4),
    X_FILES,
    undefined,
    { before: [], after: [] },
  );
  expect(bare.section.removedAttributed).toBe(false);
  expect(bare.state).toBe("partial");
  expect(bare.gap).toBe(true);
  // No base structure, or one with no symbols capability: not known.
  const hunk = diff("x.ts", F_BASE, F_HEAD);
  const owned = [
    { hunkId: hunk[0]!.hunkId, side: "old" as const, startLine: 2, endLine: 2 },
  ];
  expect(removalAttribution(owned, hunk, new Map())).toEqual({
    removedAttributed: null,
    removedHeads: [],
  });
  expect(
    removalAttribution(
      owned,
      hunk,
      new Map([
        [oidOf(F_BASE), noStructure("unsupported-language", null, 3)],
        [
          oidOf(F_HEAD),
          symbolStructure(F_HEAD, [
            { start: 1, end: 3, kind: "declaration", name: "f" },
          ]),
        ],
      ]),
    ),
  ).toEqual({ removedAttributed: null, removedHeads: [] });
  // And a plan section whose attribution is not known keeps the gap.
  const known = await boxCase(
    BOX_OPEN_1,
    BOX_OPEN_2,
    {
      before: boxGraph(5, [["open", 2, 4]]),
      after: boxGraph(5, [["open", 2, 4]]),
    },
    covered("open", 2),
  );
  expect(known.state).toBe("shown");
  const unknown: ReadingPlan = {
    ...known.plan,
    sections: known.plan.sections.map((section) => ({
      ...section,
      removedAttributed: null,
      removedHeads: [],
    })),
  };
  const unknownEvidence = evidenceOf(
    known.slices,
    unknown,
    undefined,
    (path, line) =>
      X_FILES[path as keyof typeof X_FILES]?.split("\n")[line - 1] ?? null,
    known.map,
  );
  expect(unknownEvidence.sections[0]!.relations).toBe("partial");
  expect(decidedX(unknown, known.map, unknownEvidence)).toBe(true);
});

// Reason (round 6d, the sections lane's limits): occurrence is only order, so a pair of same-named
// symbols may be two different ones; a rename or a move is a removal and an addition, never a pair.
test("an overload, a getter and setter of one name, a renamed member and a member moved between classes are not attributed, and the gap stays", async () => {
  const twice = (kind: string, before: string, after: string) =>
    boxCase(
      before,
      after,
      {
        before: [
          { name: "Box", kind: "class", container: null, start: 1, end: 8 },
          { name: "open", kind, container: "Box", start: 2, end: 4 },
          { name: "open", kind, container: "Box", start: 5, end: 7 },
        ],
        after: [
          { name: "Box", kind: "class", container: null, start: 1, end: 8 },
          { name: "open", kind, container: "Box", start: 2, end: 4 },
          { name: "open", kind, container: "Box", start: 5, end: 7 },
        ],
      },
      // Both head symbols of the name, and the class, have both rows.
      [...covered("open1", 2), ...covered("open2", 3), ...covered("Box", 4)],
      [
        { id: "Box", start: 1, end: 8 },
        { id: "open1", start: 2, end: 4 },
        { id: "open2", start: 5, end: 7 },
      ],
    );
  const overload = await twice(
    "method",
    "export class Box {\n  open(a: string) {\n    return 1;\n  }\n  open(a: number) {\n    return 1;\n  }\n}\n",
    "export class Box {\n  open(a: string) {\n    return 1;\n  }\n  open(a: number) {\n    return 2;\n  }\n}\n",
  );
  expect(overload.section.symbolRemoved).toBe(false);
  expect(overload.section.removedAttributed).toBe(false);
  expect(overload.state).toBe("partial");
  expect(overload.gap).toBe(true);
  const accessor = await twice(
    "property",
    "export class Box {\n  get open() {\n    return 1;\n  }\n  set open(v) {\n    this.v = v;\n  }\n}\n",
    "export class Box {\n  get open() {\n    return 1;\n  }\n  set open(v) {\n    this.w = v;\n  }\n}\n",
  );
  expect(accessor.section.removedAttributed).toBe(false);
  expect(accessor.gap).toBe(true);

  // A renamed member: the two rules agree.
  const renamed = await boxCase(
    BOX_OPEN_1,
    "export class Box {\n  shut() {\n    return 1;\n  }\n}\n",
    {
      before: boxGraph(5, [["open", 2, 4]]),
      after: boxGraph(5, [["shut", 2, 4]]),
    },
    [...covered("shut", 2), ...covered("Box", 4)],
  );
  expect(renamed.section.symbolRemoved).toBe(true);
  expect(renamed.section.removedAttributed).toBe(false);
  expect(renamed.gap).toBe(true);

  // A member moved from class A to class B of one file: A keeps its gap; B removes no row.
  const moved = await xCase(
    "export class A {\n  move() {\n    return 1;\n  }\n}\nexport class B {\n}\n",
    "export class A {\n}\nexport class B {\n  move() {\n    return 1;\n  }\n}\n",
    [
      { id: "A", start: 1, end: 2 },
      { id: "B", start: 3, end: 7 },
      { id: "move", start: 4, end: 6 },
    ],
    [...covered("A", 2), ...covered("B", 3), ...covered("move", 4)],
    X_FILES,
    {
      before: [
        { start: 1, end: 5, kind: "declaration", name: "A" },
        { start: 6, end: 7, kind: "declaration", name: "B" },
      ],
      after: [
        { start: 1, end: 2, kind: "declaration", name: "A" },
        { start: 3, end: 7, kind: "declaration", name: "B" },
      ],
    },
    {
      before: [
        { name: "A", kind: "class", container: null, start: 1, end: 5 },
        { name: "move", kind: "method", container: "A", start: 2, end: 4 },
        { name: "B", kind: "class", container: null, start: 6, end: 7 },
      ],
      after: [
        { name: "A", kind: "class", container: null, start: 1, end: 2 },
        { name: "B", kind: "class", container: null, start: 3, end: 7 },
        { name: "move", kind: "method", container: "B", start: 4, end: 6 },
      ],
    },
  );
  // This diff keeps move's lines as context and moves the class lines around them, so A removes no
  // row; the rule that keeps its gap is `symbolRemoved` (A's span lost move).
  const a = moved.byName("A");
  expect(a.section.symbolRemoved).toBe(true);
  expect(a.section.removedHeads).toEqual([]);
  expect(a.gap).toBe(true);
});

// Reason (round 6d): the plan's new fields take each of their states from the structures, never a
// default.
test("the plan says whether every removed row was attributed as true, false or null, with the head symbols", async () => {
  const range = mixedRange();
  const mixed = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const by = (path: string, name: string | null) =>
    [...mixed.sections, ...mixed.unread].find(
      (s) => s.path === path && s.name === name,
    )!;
  // Removes no row: true, with no head symbol.
  expect(by("src/parse.ts", "count")).toMatchObject({
    removedAttributed: true,
    removedHeads: [],
  });
  // A replaced line in helper: true, helper's own head lines.
  expect(by("src/parse.ts", "helper")).toMatchObject({
    removedAttributed: true,
    removedHeads: [{ startLine: 3, endLine: 6 }],
  });
  // A removed declaration: no head counterpart, false.
  expect(by("src/old.ts", "drop")).toMatchObject({
    removedAttributed: false,
    removedHeads: [],
  });
  // A file with no structure: not known.
  expect(mixed.sections.find((s) => s.path === "notes.txt")).toMatchObject({
    removedAttributed: null,
    removedHeads: [],
  });
  for (const section of [...mixed.sections, ...mixed.unread]) {
    expect([true, false, null]).toContain(section.removedAttributed);
    if (section.removedAttributed !== true)
      expect(section.removedHeads).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------
// Round 6e: only a resolved edge lifts the gap
// ---------------------------------------------------------------------------------------------

const F_ONLY = {
  before: "export function f() {\n  return 1;\n}\n",
  after: "export function f() {\n  return 2;\n}\n",
};
const TRUST_FILES = {
  ...X_FILES,
  "p1.ts": "export const c1 = () => f(1);\n",
  "p2.ts": "export const c2 = () => f(2);\n",
};
/** A caller of f outside tests (`p<n>.ts`), resolved or matched by name over an import. */
const fCaller = (n: number, byName: boolean): XCall => ({
  from: `c${n}`,
  to: "f",
  path: `p${n}.ts`,
  line: 1,
  ...(byName ? { resolution: "name_only" } : {}),
});
/** f's test call, resolved or matched by name over an import. */
const fTest = (byName: boolean): XCall => ({
  from: "file:tests/t.test.ts",
  to: "f",
  path: "tests/t.test.ts",
  line: 4,
  ...(byName ? { resolution: "name_only" } : {}),
});
/** Every caller file imports x.ts, so a match by name is kept as `import-backed`. */
const IMPORTS_X = [
  ["p1.ts", "x.ts"],
  ["p2.ts", "x.ts"],
  ["tests/t.test.ts", "x.ts"],
] as const;
const trustCase = (calls: ReadonlyArray<XCall>) =>
  xCase(
    F_ONLY.before,
    F_ONLY.after,
    [{ id: "f", start: 1, end: 3 }],
    calls,
    TRUST_FILES,
    undefined,
    undefined,
    IMPORTS_X,
  );

// Reason (round 6e): a match by name alone is wrong one time in three, and must never move work
// away from a person.
test("a planted name-only match: shown as unconfirmed context, the section partial, the gap and a person's lane kept", async () => {
  // c1 in p1.ts calls another file's own f (`cf`, resolved); the index also holds a match by name
  // from c1 to x.ts's f, backed by p1.ts importing x.ts, and the same for the test file.
  const planted = await xCase(
    F_ONLY.before,
    F_ONLY.after,
    [{ id: "f", start: 1, end: 3 }],
    [
      fCaller(1, true),
      fTest(true),
      { from: "c1", to: "cf", path: "p1.ts", line: 1 },
    ],
    TRUST_FILES,
    undefined,
    undefined,
    IMPORTS_X,
  );
  const support = (slice: RelationSlice | undefined) =>
    slice?.head.symbols.find((entry) => entry.symbol.id === "f")!
      .callers as unknown as { shown: ReadonlyArray<{ support: string }> };
  expect(
    support(planted.slices.get(planted.section.key)).shown.map(
      (c) => c.support,
    ),
  ).toEqual(["import-backed", "import-backed"]);
  expect(planted.evidence.sections[0]!.rows.map((r) => r.confirmed)).toEqual([
    false,
    false,
  ]);
  expect(planted.state).toBe("partial");
  expect(planted.gap).toBe(true);
  expect(planted.lane).toBe("human-suggested");
  // The reading marks both rows, and its legend says what the mark means.
  const reading = renderReading(planted.plan, planted.plan.groups[0]!.id, {
    for: "assess",
    hunks: planted.map,
    structures: new Map(),
    evidence: planted.evidence,
  });
  const rows = reading.text
    .split("\n")
    .filter((line) => /^(caller|test) of /.test(line));
  expect(rows).toEqual([
    "caller of f, unconfirmed, called here: p1.ts line 1\texport const c1 = () => f(1);",
    "test of f, unconfirmed, called here: tests/t.test.ts line 4\ttest('f', () => x.f());",
  ]);
  expect(reading.text).toContain(
    'A row marked "unconfirmed" was matched by name only; it may point at another function of the same name.',
  );
  expect(CALLER_ROWS).toContain(
    "A row marked unconfirmed was matched by name only; it may point at another function of the same name.",
  );
});

// Reason (round 6e): the requirement is met only by a resolved row. Round 9 (the owner's ruling,
// decision 14.19): a test row is never evidence, so its match no longer counts for or against the
// lift.
test("a resolved caller lifts the gap whatever its test row's match; a name-matched caller keeps it; both resolved is shown", async () => {
  const testByName = await trustCase([fCaller(1, false), fTest(true)]);
  expect(testByName.evidence.sections[0]!.rows.map((r) => r.confirmed)).toEqual(
    [true, false],
  );
  expect(testByName.state).toBe("shown");
  expect(testByName.gap).toBe(false);
  const callerByName = await trustCase([fCaller(1, true), fTest(false)]);
  expect(
    callerByName.evidence.sections[0]!.rows.map((r) => r.confirmed),
  ).toEqual([false, true]);
  expect(callerByName.state).toBe("partial");
  expect(callerByName.gap).toBe(true);
  const both = await trustCase([fCaller(1, false), fTest(false)]);
  expect(both.state).toBe("shown");
  expect(both.gap).toBe(false);
  expect(both.lane).toBe("static-automation");
});

/** The same call, matched by the receiver's type over an import (`type_inferred`). */
const byType = (call: XCall): XCall => ({
  ...call,
  resolution: "type_inferred",
});

/** A case's slices as an older build cut them: the chosen rows do not say how they were matched. */
const olderBuild = (
  slices: ReadonlyMap<string, RelationSlice>,
  kind: "caller" | "test" | "both",
) =>
  new Map(
    [...slices].map(([key, slice]): [string, RelationSlice] => {
      const copy = structuredClone(slice) as unknown as {
        head: {
          symbols: Array<{
            callers:
              | { evidence: "none" }
              | {
                  evidence: "supported";
                  shown: Array<{ test: boolean; matched?: string }>;
                };
          }>;
        };
      };
      for (const entry of copy.head.symbols)
        if (entry.callers.evidence === "supported")
          for (const row of entry.callers.shown)
            if (kind === "both" || (kind === "test") === row.test)
              delete row.matched;
      return [key, copy as unknown as RelationSlice];
    }),
  );

// Reason (round 7): a receiver-type row lifting the gap is the only widening of when work may leave
// a person, so exactly that widening, and nothing more, must hold. Round 9: only the caller row is
// read for it.
test("a receiver-type caller row lifts the gap; a name-only caller row does not, and a test row's match counts for nothing; a row that does not say how it was matched is not shown and lifts nothing", async () => {
  expect(lifts({ matched: "resolved" })).toBe(true);
  expect(lifts({ matched: "receiver-type" })).toBe(true);
  expect(lifts({ matched: "name-only" })).toBe(false);
  expect(lifts({})).toBe(false);

  const typed = await trustCase([
    byType(fCaller(1, false)),
    byType(fTest(false)),
  ]);
  const callers = typed.slices
    .get(typed.section.key)!
    .head.symbols.find((entry) => entry.symbol.id === "f")!.callers;
  if (callers.evidence !== "supported") throw new Error("no callers");
  expect(callers.shown.map((c) => [c.matched, c.support])).toEqual([
    ["receiver-type", "import-backed"],
    ["receiver-type", "import-backed"],
  ]);
  expect(
    typed.evidence.sections[0]!.rows.map((r) => [r.kind, r.confirmed]),
  ).toEqual([
    ["caller", true],
    ["test", true],
  ]);
  expect(typed.state).toBe("shown");
  expect(typed.gap).toBe(false);
  expect(typed.lane).toBe("static-automation");

  // A name-only test row beside a receiver-type caller row: the test row is context, so it lifts.
  const testNamed = await trustCase([byType(fCaller(1, false)), fTest(true)]);
  expect(
    testNamed.evidence.sections[0]!.rows.map((r) => [r.kind, r.confirmed]),
  ).toEqual([
    ["caller", true],
    ["test", false],
  ]);
  expect(testNamed.state).toBe("shown");
  expect(testNamed.gap).toBe(false);
  // A name-only caller row keeps the gap, whatever the test row.
  const named = await trustCase([fCaller(1, true), byType(fTest(false))]);
  expect(named.evidence.sections[0]!.rows.map((r) => r.confirmed)).toEqual([
    false,
    true,
  ]);
  expect(named.state).toBe("partial");
  expect(named.gap).toBe(true);
  expect(named.lane).toBe("human-suggested");

  // The same receiver-type rows from an older build's slice, which does not say how they were
  // matched: never shown, so such a caller row lifts nothing; with only the test rows from it, the
  // caller row still lifts.
  const lines = (path: string, line: number) =>
    (TRUST_FILES as Record<string, string>)[path]?.split("\n")[line - 1] ??
    null;
  for (const [kind, rows, state] of [
    ["caller", ["test"], "partial"],
    ["test", ["caller"], "shown"],
    ["both", [], "no-evidence"],
  ] as const) {
    const older = evidenceOf(
      olderBuild(typed.slices, kind),
      typed.plan,
      undefined,
      lines,
      typed.map,
    );
    expect(older.sections[0]!.rows.map((r) => r.kind)).toEqual([...rows]);
    expect(older.sections[0]!.relations).toBe(state);
    expect(decidedX(typed.plan, typed.map, older)).toBe(state !== "shown");
  }
});

// Reason (rounds 9 and 13): the lift is the one place work can leave a person, so each kind of row is
// held to whether it lifts: only a trusted caller row from a file a followed declaration classifies
// as not a test, whose line is the call itself or the name handed over.
test("lift table: a trusted call or reference from a file that is not a test file lifts; a caller-only row with or without a line, a name-only row kept on an import, an undecided file's call, a caller in a test file and a test row do not; a section with test rows only keeps its gap", async () => {
  // The rule on one row.
  const call = {
    kind: "caller" as const,
    symbol: "f",
    path: "b.ts",
    shows: "call" as const,
    line: 2,
    text: "f(1);",
    from: "g",
    confirmed: true,
  };
  const table: ReadonlyArray<
    readonly [string, Parameters<typeof rowLifts>[0], boolean]
  > = [
    ["a trusted call", call, true],
    ["a name handed over", { ...call, shows: "reference" }, true],
    [
      "a trusted call from an undecided file",
      { ...call, undecided: true },
      false,
    ],
    ["only the caller, its first line", { ...call, shows: "caller" }, false],
    [
      "only the caller, no line",
      { ...call, shows: "caller", line: null, text: null },
      false,
    ],
    ["matched by name only", { ...call, confirmed: false }, false],
    ["a caller in a test file (a test row)", { ...call, kind: "test" }, false],
  ];
  for (const [name, row, lifted] of table)
    expect([name, rowLifts(row)]).toEqual([name, lifted]);

  // The rule on a section: h has one caller, g, at line 3.
  const h = sectionOf("a.ts", "h").key;
  const base = await indexOf();
  const hEdge = (at: number) =>
    base.strings[base.edges.target[at]!] === "h" &&
    base.edges.sourceSymbol[at] !== -1 &&
    base.strings[base.edges.sourceSymbol[at]!] === "g";
  const hState = async (index: typeof base) => {
    const evidence = evidenceOf(slicesOf(index));
    return {
      state: stateOf(evidence, h),
      gap: decided(plan, evidence)(h).gap,
      rows: evidence.sections
        .find((s) => s.key === h)!
        .rows.map((r) => [r.kind, r.shows, r.confirmed]),
    };
  };
  expect(await hState(base)).toEqual({
    state: "shown",
    gap: false,
    rows: [["caller", "call", true]],
  });
  expect(
    await hState(
      withShows(base, ({ at }) => (hEdge(at) ? "reference" : undefined)),
    ),
  ).toEqual({
    state: "shown",
    gap: false,
    rows: [["caller", "reference", true]],
  });
  expect(
    await hState(
      withShows(base, ({ at }) => (hEdge(at) ? "caller" : undefined)),
    ),
  ).toEqual({
    state: "partial",
    gap: true,
    rows: [["caller", "caller", true]],
  });
  // g's call to h recorded with no line: a caller-only row with none.
  const noLine = await hState(
    await indexOf({
      calls: CALLS.map((c) =>
        c.to === "h" && c.from === "g" ? { ...c, line: null } : c,
      ),
    }),
  );
  expect(noLine).toEqual({
    state: "partial",
    gap: true,
    rows: [["caller", "caller", true]],
  });
  // h's only caller in a test file: a test row, context, so the gap stays.
  const fromTest = await hState(
    await indexOf({
      calls: [
        ...CALLS.filter((c) => c.to !== "h"),
        { from: "file:tests/b.test.ts", to: "h", line: 3 },
      ],
    }),
  );
  expect(fromTest).toEqual({
    state: "partial",
    gap: true,
    rows: [["test", "call", true]],
  });

  // A name-only caller kept because its file imports the target (`import-backed`): context.
  const named = await trustCase([fCaller(1, true)]);
  const kept = named.slices
    .get(named.section.key)!
    .head.symbols.find((entry) => entry.symbol.id === "f")!.callers;
  if (kept.evidence !== "supported") throw new Error("no callers");
  expect(kept.shown.map((c) => [c.matched, c.support])).toEqual([
    ["name-only", "import-backed"],
  ]);
  expect(named.state).toBe("partial");
  expect(named.gap).toBe(true);
  // A section with test rows only, trusted calls all, keeps its gap.
  const testsOnly = await trustCase([fTest(false)]);
  expect(
    testsOnly.evidence.sections[0]!.rows.map((r) => [r.kind, rowLifts(r)]),
  ).toEqual([["test", false]]);
  expect(testsOnly.state).toBe("partial");
  expect(testsOnly.gap).toBe(true);
});

// Reason (the owner's ruling of 13 November): a recognised test is a hint for the model, never
// evidence in code, so a section needs no test row to lose its gap.
test("removing the test half: a section whose every changed symbol has a lifting caller row and no test row at all is shown and takes the rule's lane, switch on", async () => {
  const alone = await trustCase([fCaller(1, false)]);
  const symbol = alone.slices
    .get(alone.section.key)!
    .head.symbols.find((entry) => entry.symbol.id === "f")!;
  expect(symbol.testCallers).toEqual({ evidence: "none" });
  expect(alone.evidence.sections[0]!.rows.map((r) => r.kind)).toEqual([
    "caller",
  ]);
  expect(alone.state).toBe("shown");
  expect(alone.gap).toBe(false);
  expect(alone.lane).toBe("static-automation");
  // Two changed symbols, each with a caller row and neither with a test row: the class Box and its
  // method open, both called from outside tests.
  const K_BEFORE = "export class Box {\n  a = 1;\n  open() { return 1; }\n}\n";
  const K_AFTER = "export class Box {\n  a = 2;\n  open() { return 2; }\n}\n";
  const kHunks = diff("k.ts", K_BEFORE, K_AFTER);
  const kMap = new Map(kHunks.map((hunk) => [hunk.hunkId, hunk]));
  const kPlan = planReadings({
    hunks: kHunks,
    structures: new Map(
      [K_BEFORE, K_AFTER].map((text) => [
        oidOf(text),
        symbolStructure(text, [
          { start: 1, end: 4, kind: "declaration", name: "Box" },
        ]),
      ]),
    ),
  });
  const evidence = evidenceOf(
    slicesOf(
      await indexOf({
        symbols: [
          ...SYMBOLS,
          { id: "Box", path: "k.ts", start: 1, end: 4 },
          { id: "open", path: "k.ts", start: 3, end: 3 },
        ],
        calls: [
          ...CALLS,
          { from: "g", to: "open", line: 2 },
          { from: "mm", to: "Box", line: 5 },
        ],
      }),
      kPlan,
      kMap,
    ),
    kPlan,
    undefined,
    undefined,
    kMap,
  );
  expect(evidence.sections[0]!.rows.map((r) => [r.kind, r.symbol])).toEqual([
    ["caller", "open"],
    ["caller", "Box"],
  ]);
  expect(evidence.sections[0]!.relations).toBe("shown");
});

/** f and, in the same file, h, which calls f on line 5. */
const F_AND_H = {
  before:
    "export function f() {\n  return 1;\n}\nexport function h() {\n  return x.f();\n}\n",
  after:
    "export function f() {\n  return 2;\n}\nexport function h() {\n  return x.f();\n}\n",
};
const sameFileCase = (resolution: string) =>
  xCase(
    F_AND_H.before,
    F_AND_H.after,
    [
      { id: "f", start: 1, end: 3 },
      { id: "h", start: 4, end: 6 },
    ],
    [{ from: "h", to: "f", path: "x.ts", line: 5, resolution }, fTest(false)],
    { ...TRUST_FILES, "x.ts": F_AND_H.after },
  );

// Reason (round 7b): the same-file shape was hand-checked: 60 right of 60
// (`coordination/neu-148/reviews/graph-9b-receiver-type-hand-check.md`). A later narrowing must
// change this test on purpose.
test("a same-file receiver-type caller with a trusted test lifts the gap", async () => {
  const typed = await sameFileCase("type_inferred");
  const callers = typed.slices
    .get(typed.section.key)!
    .head.symbols.find((entry) => entry.symbol.id === "f")!.callers;
  if (callers.evidence !== "supported") throw new Error("no callers");
  expect(callers.shown.map((c) => [c.caller.path, c.matched, c.test])).toEqual([
    ["tests/t.test.ts", "resolved", true],
    ["x.ts", "receiver-type", false],
  ]);
  expect(
    typed.evidence.sections[0]!.rows.map((r) => [r.kind, r.path, r.confirmed]),
  ).toEqual([
    ["caller", "x.ts", true],
    ["test", "tests/t.test.ts", true],
  ]);
  expect(typed.state).toBe("shown");
  expect(typed.gap).toBe(false);
  expect(typed.lane).toBe("static-automation");
});

// Reason (round 7b, the review's N1): a caller is told test or not by its own path, while its row
// shows its call site's path; a site in another file could make one line both rows and lift the gap.
test("a caller whose call site is in another file gives no row, so one site is never both rows", async () => {
  // g in b.ts, with its call site placed in the test file; and the test file's own call there.
  const sited = await xCase(
    F_ONLY.before,
    F_ONLY.after,
    [{ id: "f", start: 1, end: 3 }],
    [{ from: "g", to: "f", path: "tests/t.test.ts", line: 4 }, fTest(false)],
    TRUST_FILES,
  );
  expect(sited.rows).toEqual(["test of f"]);
  expect(sited.state).toBe("partial");
  expect(sited.gap).toBe(true);
  // Alone, it gives nothing.
  const alone = await xCase(
    F_ONLY.before,
    F_ONLY.after,
    [{ id: "f", start: 1, end: 3 }],
    [{ from: "g", to: "f", path: "tests/t.test.ts", line: 4 }],
    TRUST_FILES,
  );
  expect(alone.rows).toEqual([]);
  expect(alone.state).toBe("no-evidence");
  expect(alone.gap).toBe(true);
});

// Reason (round 7): round 6's planted wrong edge (a same-named function in another file) must lift
// nothing however the index holds it: kept as a match by name only, or not kept at all.
test("the planted wrong edge lifts nothing, whether the index keeps it as name-only or does not keep it", async () => {
  for (const imports of [IMPORTS_X, []] as const) {
    const planted = await xCase(
      F_ONLY.before,
      F_ONLY.after,
      [{ id: "f", start: 1, end: 3 }],
      [
        fCaller(1, true),
        fTest(true),
        { from: "c1", to: "cf", path: "p1.ts", line: 1 },
      ],
      TRUST_FILES,
      undefined,
      undefined,
      imports,
    );
    const callers = planted.slices
      .get(planted.section.key)!
      .head.symbols.find((entry) => entry.symbol.id === "f")!.callers;
    if (imports.length > 0) {
      // Kept, by the import, as a match by name only: shown unconfirmed.
      if (callers.evidence !== "supported") throw new Error("not kept");
      expect(callers.trusted).toBe(0);
      expect(callers.shown.map((c) => c.matched)).toEqual([
        "name-only",
        "name-only",
      ]);
      expect(planted.state).toBe("partial");
    } else {
      // Not kept: no row at all.
      expect(callers.evidence).toBe("none");
      expect(planted.state).toBe("no-evidence");
    }
    expect(planted.evidence.sections[0]!.rows.some((r) => r.confirmed)).toBe(
      false,
    );
    expect(planted.gap).toBe(true);
    expect(planted.lane).toBe("human-suggested");
  }
});

// Reason (round 6e): a resolved caller later in the slice's order must be preferred, and never shown
// beside the name-matched one.
test("an earlier name-matched caller and a later resolved one: the resolved one is shown alone and lifts", async () => {
  const later = await trustCase([
    fCaller(1, true),
    fCaller(2, false),
    fTest(false),
  ]);
  const rows = later.evidence.sections[0]!.rows;
  expect(rows.map((r) => [r.kind, r.path, r.confirmed])).toEqual([
    ["caller", "p2.ts", true],
    ["test", "tests/t.test.ts", true],
  ]);
  expect(later.state).toBe("shown");
  expect(later.gap).toBe(false);
});

// Reason (round 6c): a decision reads the file of every call site it tries, so the number tried
// must be bounded by construction, or widely used code carries a group past the time bound.
test("at most five call sites are tried per symbol and kind: a readable sixth is never read and gives no row", async () => {
  expect(CANDIDATES_PER_KIND).toBe(5);
  const bounded = await xCase(
    "export function f() {\n  return 1;\n}\n",
    "export function f() {\n  return 2;\n}\n",
    [{ id: "f", start: 1, end: 3 }],
    [
      // Six callers outside tests; the first five's files have no such line, the sixth's does.
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        from: `c${n}`,
        to: "f",
        path: `p${n}.ts`,
        line: 1,
      })),
      {
        from: "file:tests/t.test.ts",
        to: "f",
        path: "tests/t.test.ts",
        line: 4,
      },
    ],
    X_FILES,
  );
  expect(bounded.rows).toEqual(["test of f"]);
  expect(bounded.state).toBe("partial");
  expect(bounded.gap).toBe(true);
  // Only the five were looked at, and only their files (and the test's) are read for the group.
  expect([...new Set(bounded.asked)].sort()).toEqual([
    "p1.ts",
    "p2.ts",
    "p3.ts",
    "p4.ts",
    "p5.ts",
    "tests/t.test.ts",
  ]);
  expect(
    callSitePaths(
      bounded.plan,
      bounded.plan.groups[0]!.id,
      bounded.slices,
      bounded.map,
    ),
  ).toEqual(["p1.ts", "p2.ts", "p3.ts", "p4.ts", "p5.ts", "tests/t.test.ts"]);
});

// Reason (round 7, N-j): test files usually sort after source files, so widely used code showed no
// test row when only the first twenty callers were told apart. Every shown caller is now told test
// or not by its path, while the call sites read stay five per kind.
test("a symbol with thirty source callers and one test caller that sorts last gets its test row; the call sites tried stay five per kind", async () => {
  const wide = await xCase(
    F_ONLY.before,
    F_ONLY.after,
    [{ id: "f", start: 1, end: 3 }],
    [
      ...Array.from({ length: 30 }, (_, at) => ({
        from: `c${at + 1}`,
        to: "f",
        path: `p${at + 1}.ts`,
        line: 1,
      })),
      {
        from: "file:tests/t.test.ts",
        to: "f",
        path: "tests/t.test.ts",
        line: 4,
      },
    ],
    { ...X_FILES, "p1.ts": "export const c1 = () => x.f(1);\n" },
  );
  const callers = wide.slices
    .get(wide.section.key)!
    .head.symbols.find((entry) => entry.symbol.id === "f")!.callers;
  if (callers.evidence !== "supported") throw new Error("no callers");
  // All 31 are shown, the test file last, and the slice says which one is a test.
  expect(callers.shown).toHaveLength(31);
  expect(callers.shown.at(-1)!.caller.path).toBe("tests/t.test.ts");
  expect(callers.shown.filter((c) => c.test).map((c) => c.caller.path)).toEqual(
    ["tests/t.test.ts"],
  );
  expect(wide.rows).toEqual(["caller of f", "test of f"]);
  expect(wide.state).toBe("shown");
  expect(wide.gap).toBe(false);
  // The first five source callers by path, and the test file: no other call site is tried, and
  // only the first readable one of each kind is read.
  expect(
    callSitePaths(wide.plan, wide.plan.groups[0]!.id, wide.slices, wide.map),
  ).toEqual([
    "p1.ts",
    "p10.ts",
    "p11.ts",
    "p12.ts",
    "p13.ts",
    "tests/t.test.ts",
  ]);
  expect([...new Set(wide.asked)].sort()).toEqual(["p1.ts", "tests/t.test.ts"]);
});

/** A step's key as the route joins it. */
const keyOf = <O, S>(
  step: Pick<AgentStep<O, S>, "spec" | "op" | "opVersion" | "inputs">,
) =>
  Computations.computationKey(agentStageSpec(defaultConfig(), step.spec, step))
    .key;

/**
 * The step without what it is offered (`offered`, the readers' round 15): the parent keys below
 * predate that input, which moved every Assess, Lane review and claim-check key on purpose.
 */
const withoutOffered = <O, S>(
  step: Pick<AgentStep<O, S>, "spec" | "op" | "opVersion" | "inputs">,
) => {
  const { offered: _offered, ...inputs } = step.inputs;
  return { ...step, inputs };
};

/** A group's Assess, Lane review and one claim check over the given evidence. */
const stepsOver = (evidence: GroupEvidence | undefined) => {
  const sources = { hunks, structures: structures(), evidence };
  const f = sectionOf("a.ts", "f").key;
  return {
    assess: keyOf(
      erased(
        assessStep({
          stage: "verify",
          reading: renderReading(plan, group.id, { for: "assess", ...sources }),
        }),
      ),
    ),
    review: keyOf(
      erased(
        laneReviewStep({
          stage: "verify",
          reading: renderReading(plan, group.id, {
            for: "lane-review",
            ...sources,
          }),
          goal: { goal: "g", doneWhen: [] },
          tools: [],
          keys: { frame: "frame-a", manifest: "manifest-a" },
        }),
      ),
    ),
    claim: keyOf(
      erased(
        claimVerifyStep({
          key: "a".repeat(64),
          section: f,
          comment: {
            path: "a.ts",
            side: "new",
            startLine: 3,
            endLine: 3,
            text: "t",
            fails: "",
          },
          reading: renderReading(plan, group.id, {
            for: "lane-review",
            ...sources,
            only: [f],
          }),
          turnLimit: 4,
        }),
      ),
    ),
  };
};

// The stage key now covers the context ceiling. These stage pins use the parent commit's inputs.
const PARENT = {
  // Re-pinned (round 25): the pipeline version moved from 11 to 12.
  runKeyOff: "eb644e039b6bd267141e4fac4fd924486e3867fc70fdc0a37ce2a046631c5419",
  assess: "d4ce158ffb74a3980be27356da6df7445914db5ae7c7922b4836938cb522955f",
  review: "9759405c5bf0671c9f0de6089f912a8d07166961dd93dc90e5cb507b0b68cab7",
  claim: "2e1f21570f0dc9d0da9e20ad3bd84caedd89e2a797b50af54c9ac72787a1e980",
};

// Reason: stored answers must be shared exactly when the question is the same.
test("equal reading evidence shares step keys across runs, and changed evidence moves the keys of steps that read it", async () => {
  const slices = slicesOf(await indexOf());
  // Two runs that decided apart (another run, another stored read of the same commit) and show the
  // same rows: one stored answer.
  const one = stepsOver(
    evidenceOf(slices, plan, { head: "run-1", base: null }),
  );
  const two = stepsOver(
    evidenceOf(slices, plan, { head: "run-2", base: "base" }),
  );
  expect(two).toEqual(one);
  // Other rows (h's test caller now shown): every step of the group keys apart.
  const other = stepsOver(
    evidenceOf(
      slicesOf(
        await indexOf({
          calls: [...CALLS, { from: "file:tests/b.test.ts", to: "h", line: 3 }],
        }),
      ),
    ),
  );
  expect(other.assess).not.toBe(one.assess);
  expect(other.review).not.toBe(one.review);
  // The claim check reads f alone, whose rows did not change.
  expect(other.claim).toBe(one.claim);
  // No evidence, or a decision that shows nothing, is the reading without any.
  const none = stepsOver(undefined);
  expect(stepsOver(evidenceOf(null))).toEqual(none);
  expect(none.assess).not.toBe(one.assess);
  expect(none.claim).not.toBe(one.claim);

  // The run key still matches the parent. The step pins below use the mixed range's parent inputs.
  expect(
    runKeyFor(
      { baseRef: "main", baseOid: "1".repeat(40), headOid: "2".repeat(40) },
      defaultConfig(),
    ),
  ).toBe(PARENT.runKeyOff);
  const range = mixedRange();
  const mixed = planReadings({
    hunks: range.hunks,
    structures: range.structures,
    excluded: range.excluded,
  });
  const mixedHunks = new Map(range.hunks.map((h) => [h.hunkId, h]));
  const at = mixed.groups[0]!;
  const sources = { hunks: mixedHunks, structures: range.structures };
  const mixedClaim = erased(
    claimVerifyStep({
      key: "a".repeat(64),
      section: at.keys[0]!,
      comment: {
        path: "x",
        side: "new",
        startLine: 1,
        endLine: 1,
        text: "t",
        fails: "",
      },
      reading: renderReading(mixed, at.id, {
        for: "lane-review",
        ...sources,
        only: [at.keys[0]!],
      }),
      turnLimit: 4,
    }),
  );
  // A claim check shown no evidence matches its pin with the offered input removed.
  expect(keyOf(withoutOffered(mixedClaim))).toBe(PARENT.claim);
  expect(keyOf(mixedClaim)).not.toBe(PARENT.claim);
  const mixedAssess = erased(
    assessStep({
      stage: "verify",
      reading: renderReading(mixed, at.id, { for: "assess", ...sources }),
    }),
  );
  const mixedReview = erased(
    laneReviewStep({
      stage: "verify",
      reading: renderReading(mixed, at.id, {
        for: "lane-review",
        ...sources,
      }),
      goal: { goal: "g", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-a", manifest: "manifest-a" },
    }),
  );
  expect(keyOf(mixedAssess)).not.toBe(PARENT.assess);
  expect(keyOf(mixedReview)).not.toBe(PARENT.review);
  // Restoring the parent recipe, prompt versions, stored version and offered input recovers the pins.
  for (const [step, parent, back] of [
    [mixedAssess, PARENT.assess, { by: 7 }],
    [mixedReview, PARENT.review, { by: 9, answer: 4 }],
  ] as const)
    expect(
      keyOf({
        ...step,
        // Rounds 6, 6e, 7, 7d and 10 each moved the prompt versions by one; round 9 by two, past
        // the scope-and-tests variants' numbers. Round 15 added what the step is offered; round 17
        // moved the stored version from 2 (the producer is stored with the output). The readers'
        // round 30 moved Lane review's prompt by two more and its answer from 4 to 6 (each row's
        // reading), past the variants' numbers.
        opVersion: step.opVersion - back.by,
        inputs: {
          ...withoutOffered(step).inputs,
          recipe: "neuve-reading-v3",
          stored: 2,
          ...("answer" in back ? { answer: back.answer } : {}),
        },
      }),
    ).toBe(parent);
});

// ---------------------------------------------------------------------------------------------
// The decision in a real store, from relations the graph lane's own computation stored
// ---------------------------------------------------------------------------------------------

const ENGINE = "NEUVE_GRAPH_OUTLINE_EXECUTABLE";
const engineBefore = process.env[ENGINE];
/**
 * The real engine, as the graph lane's real-engine tests find it (`NEUVE_GRAPH_OUTLINE_EXECUTABLE`,
 * else the built `apps/neuve-graph/entire-graph`), taken before any test points the variable at a
 * fixture engine; and whether it can read a commit, as those tests require.
 */
const REAL_SOURCE = captureOutlineSource();
const realCapable = (() => {
  if (!("sha256" in REAL_SOURCE.key)) return false;
  const result = Bun.spawnSync(
    [REAL_SOURCE.executable, "capabilities", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.toString()) as {
      optional_local_only_features?: { exact_commit_bulk_streams?: unknown };
    };
    return (
      parsed.optional_local_only_features?.exact_commit_bulk_streams === true
    );
  } catch {
    return false;
  }
})();
const realEngine = graphTestPrerequisite({
  available: realCapable,
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must declare exact_commit_bulk_streams. Run `bun run build:graph` from the workspace root.",
});
const roots: Array<string> = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
  if (engineBefore === undefined) delete process.env[ENGINE];
  else process.env[ENGINE] = engineBefore;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/**
 * A real Git repository holding the head's caller files (`HEAD_FILES`) under one root manifest whose
 * test script is `script`, and the head's files by test status as a decision reads them.
 */
const statesRepository = async (script: string) => {
  const root = mkdtempSync(join(tmpdir(), "lift-states-"));
  roots.push(root);
  const files: Record<string, string> = {
    ...HEAD_FILES,
    "package.json": `${JSON.stringify({ name: "states", private: true, scripts: { test: script } })}\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  return (await headTestFilesOf(root, git(root, "rev-parse", "HEAD"))).files;
};

// Reason (round 13, "unknown means no lift"): a caller's file is a test, not a test or undecided, by
// the head's declarations read as a decision reads them, end to end on a real Git repository: a
// declared test file's call is a test row and lifts nothing, a declared not-test file's trusted call
// lifts, and the same test file under a script the reader cannot follow (`--path-ignore-patterns`)
// is undecided: its trusted call is a caller row, marked, and lifts nothing.
test("the three test states end to end on a real Git repository: a declared test file's call is a test row, a declared not-test file's call lifts, an undecided file's call is marked and keeps the gap", async () => {
  const followed = await statesRepository("bun test ./tests");
  const unfollowed = await statesRepository(
    "bun test --path-ignore-patterns 'tests/skip/**' ./tests",
  );
  // The states, by path.
  const stateIn = (files: typeof followed, path: string) =>
    files.tests.has(path)
      ? "test"
      : files.undecided.has(path)
        ? "undecided"
        : "not-test";
  expect(
    ["tests/b.test.ts", "tests/a.test.ts", "b.ts", "m.ts"].map((path) => [
      path,
      stateIn(followed, path),
      stateIn(unfollowed, path),
    ]),
  ).toEqual([
    ["tests/b.test.ts", "test", "undecided"],
    ["tests/a.test.ts", "test", "undecided"],
    ["b.ts", "not-test", "not-test"],
    ["m.ts", "not-test", "not-test"],
  ]);
  const f = sectionOf("a.ts", "f").key;
  // f called from one place only: the test file's call at line 3, or g's in b.ts at line 2.
  const fromTest = await indexOf({
    calls: [
      ...CALLS.filter((c) => c.to !== "f"),
      { from: "file:tests/b.test.ts", to: "f", line: 3 },
    ],
  });
  const fromG = await indexOf({
    calls: [
      ...CALLS.filter((c) => c.to !== "f"),
      { from: "g", to: "f", line: 2 },
    ],
  });
  const decide = (index: typeof fromTest, files: typeof followed) => {
    const slices = new Map(
      relationSlices(
        { base: { gap: "over-bound", tag: null }, head: index },
        relationSubjects(plan, hunks),
        { base: () => false, head: (path) => files.tests.has(path) },
      ).map((slice): [string, RelationSlice] => [slice.key, slice]),
    );
    const evidence = evidenceOf(
      slices,
      plan,
      undefined,
      lineAt,
      hunks,
      files.undecided,
    );
    const section = evidence.sections.find((s) => s.key === f)!;
    return {
      state: section.relations,
      gap: decided(plan, evidence)(f).gap,
      rows: section.rows.map((r) => [r.kind, r.path, r.undecided ?? false]),
    };
  };
  // A declared test file: a test row, context; the gap stays.
  expect(decide(fromTest, followed)).toEqual({
    state: "partial",
    gap: true,
    rows: [["test", "tests/b.test.ts", false]],
  });
  // A declared not-test file: its trusted call lifts, under either script.
  for (const files of [followed, unfollowed])
    expect(decide(fromG, files)).toEqual({
      state: "shown",
      gap: false,
      rows: [["caller", "b.ts", false]],
    });
  // The same test file under a script the reader cannot follow: undecided, a caller row marked so,
  // which lifts nothing; the gap stays.
  expect(decide(fromTest, unfollowed)).toEqual({
    state: "partial",
    gap: true,
    rows: [["caller", "tests/b.test.ts", true]],
  });
});

const F_BASE = "export function f(x: number) {\n  return x + 1;\n}\n";
const F_HEAD = "export function f(x: number) {\n  return x + 2;\n}\n";
const B_TEXT = 'import { f } from "./a";\nexport const g = () => f(1);\n';
const T_TEXT =
  'import { f } from "../a";\ntest("f", () => expect(f(1)).toBe(3));\n';

/**
 * A fake engine, as the relations task's tests use one: its snapshot (`--commit`) writes a small
 * compact stream and records the commit; it holds while its mode is `gated` until `release` exists,
 * and fails in mode `fail`. Anything else it is asked it refuses.
 *
 * It gives only what the real engine gives (round 7d): f in a.ts, called by g in b.ts (g on line 2),
 * whose call evidence is g's whole span (`call_site`, lines 2 to 2), so its site line is g's first
 * line; and called from tests/a.test.ts outside every function (`top_level_call_site`, the file's
 * path and no line), as a call inside a Bun `test(...)` callback is.
 */
const fakeEngine = (root: string) => {
  const control = join(root, "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, "mode"), "valid");
  const executable = join(root, "engine");
  const script = `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const control = ${JSON.stringify(control)};
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
if (args[0] === "version") out({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") out({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["CALLS"],relation_support_by_language:{},relation_support_by_profile:{full:["CALLS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{compact_snapshot_ndjson_v1:true,exact_commit_bulk_streams:true},features_requiring_network_access:{}});
else if (!args.includes("--commit")) process.exit(2);
else {
  const mode = readFileSync(control + "/mode", "utf8");
  const commit = args[args.indexOf("--commit") + 1];
  appendFileSync(control + "/spawns", commit + "\\n");
  out(["h", 1, {schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:args[args.indexOf("--repo") + 1],repo_key:"local/r",commit,tree:"2".repeat(40),profile:"full",relation_set:["CALLS","IMPORTS"],skipped_relation_families:[]}]);
  if (mode === "fail") process.exit(3);
  out(["d", 1, ["file:a.ts","a.ts","blob","TypeScript","file:b.ts","b.ts","file:tests/a.test.ts","tests/a.test.ts"]]);
  out(["f", 1, 2, 3, 4, 10]); out(["f", 5, 6, 3, 4, 10]); out(["f", 7, 8, 3, 4, 10]);
  out(["d", 9, ["s:f","compound-v1","function","f","s:g","g"]]);
  out(["s", 9, 10, 11, 12, 12, 2, 1, 3, 0, 0, 4, 0, []]);
  out(["s", 13, 10, 11, 14, 14, 6, 2, 2, 0, 0, 4, 0, []]);
  out(["d", 15, ["CALLS","import_resolved","IMPORTS","call_site","top_level_call_site"]]);
  out(["r", 13, 9, 15, 0.9, 0, 0, 16, 0, [[18, 6, 2, 2, 0]], []]);
  out(["r", 7, 9, 15, 0.8, 0, 0, 16, 0, [[19, 8, 0, 0, 0]], []]);
  out(["r", 5, 1, 17, 0.9, 0, 0, 16, 0, [], []]);
  if (mode === "gated") while (!existsSync(control + "/release")) await new Promise((resolve) => setTimeout(resolve, 10));
  out(["m", {record_type:"summary",languages:["TypeScript"],language_tiers:{TypeScript:"semantic"},warnings:[],partial_failures:[],stats:{files:3,parsed_files:3,symbols:2,relations:3,partial_failures:0,completeness_level:"ok"},completeness:{languages:{},relations:{}}}]);
}
`;
  writeFileSync(executable, script, { mode: 0o700 });
  process.env[ENGINE] = executable;
  const lines = (file: string) =>
    existsSync(join(control, file))
      ? readFileSync(join(control, file), "utf8").trim().split("\n")
      : [];
  return {
    source: {
      executable,
      key: { sha256: createHash("sha256").update(script).digest("hex") },
    },
    mode: (mode: "valid" | "gated" | "fail") =>
      writeFileSync(join(control, "mode"), mode),
    release: () => writeFileSync(join(control, "release"), ""),
    spawns: () => lines("spawns"),
  };
};

/**
 * One review's repository (a merge base, the base branch moved past it, and the head off the merge
 * base), its Records store with every computation the store runs counted by op, its stored
 * manifest and plan, and a run context over them. By default one section, f in a.ts; `more` adds
 * one changed file per name (`<name>.ts`, holding function `<name>`), `texts` replaces b.ts and the
 * test file, and `maxItems` bounds the plan's groups.
 */
const reviewWorld = async (
  options: {
    readonly more?: ReadonlyArray<string>;
    readonly texts?: { readonly b: string; readonly test: string };
    readonly maxItems?: number;
    /** The real engine (`REAL_SOURCE`) in place of the fixture engine. */
    readonly real?: boolean;
  } = {},
) => {
  const more = options.more ?? [];
  const fn = (name: string, add: number) =>
    `export function ${name}(x: number) {\n  return x + ${add};\n}\n`;
  const root = mkdtempSync(join(tmpdir(), "readings-evidence-"));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(join(repository, "tests"), { recursive: true });
  git(repository, "init", "-q");
  writeFileSync(join(repository, "a.ts"), F_BASE);
  for (const name of more)
    writeFileSync(join(repository, `${name}.ts`), fn(name, 1));
  writeFileSync(join(repository, "b.ts"), options.texts?.b ?? B_TEXT);
  writeFileSync(
    join(repository, "tests", "a.test.ts"),
    options.texts?.test ?? T_TEXT,
  );
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "merge base");
  const mergeBase = git(repository, "rev-parse", "HEAD");
  writeFileSync(join(repository, "notes.txt"), "the base branch moved on\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "base");
  const baseOid = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-q", "-b", "topic", mergeBase);
  writeFileSync(join(repository, "a.ts"), F_HEAD);
  for (const name of more)
    writeFileSync(join(repository, `${name}.ts`), fn(name, 2));
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "head");
  const headOid = git(repository, "rev-parse", "HEAD");
  const tree = (commit: string) =>
    git(repository, "rev-parse", `${commit}^{tree}`);
  const engine = options.real
    ? (() => {
        process.env[ENGINE] = REAL_SOURCE.executable;
        return {
          source: REAL_SOURCE,
          mode: () => undefined,
          release: () => undefined,
          spawns: (): Array<string> => [],
        };
      })()
    : fakeEngine(root);

  const location = storeLocationIn(join(root, "records"));
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const built = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  const store = Context.get(built, Computations.ComputationStore);
  /** Every computation the store computes (never one it finds or shares), by op. */
  const computed: Array<string> = [];
  /**
   * The store's batch lookup, which a decision makes for the relations reads: passed through, held
   * forever (`stall`, counting each held call) or failed (`fail`), to stall or break a decision.
   */
  const gate = { mode: "pass" as "pass" | "stall" | "fail", stalled: 0 };
  /** The head's and the merge base's relations keys, and how often the store was asked for them. */
  const relationKeys = new Set(
    [headOid, mergeBase].map(
      (commit) =>
        Computations.computationKey(relationsSpec(commit, engine.source)).key,
    ),
  );
  const reads = { relations: 0, outputs: 0 };
  /**
   * The head tree's index build, as the relations task waits for it: while `held` is set, every
   * blob-chunks computation waits for it (`entered` counts them), as a build still running does.
   */
  const index: { held: Promise<void> | undefined; entered: number } = {
    held: undefined,
    entered: 0,
  };
  /** The stored relations outputs' blob hashes, as `storeRelations` stores them. */
  const relationHashes = new Set<string>();
  const blobs = Context.get(built, Blobs.BlobStore);
  // ONE blob service object for every decision of this world, as production has one: the graph
  // lane's shared load shares by that object, so a wrapper per call would hide what it shares.
  // A read counts when it runs, not when its effect is built: the graph lane's lookup builds the
  // read for every caller (`relations-index.ts`, `storedRelationsIndex`) and only the shared load
  // that runs it reads.
  const countingBlobs: typeof blobs = {
    ...blobs,
    getMany: (hashes) =>
      Effect.suspend(() => {
        if (hashes.some((hash) => relationHashes.has(hash))) reads.outputs++;
        return blobs.getMany(hashes);
      }),
  };
  const records = Context.add(
    Context.add(built, Blobs.BlobStore, countingBlobs),
    Computations.ComputationStore,
    {
      ...store,
      lookupMany: (keys) => {
        if ([...keys].some((key) => relationKeys.has(key))) reads.relations++;
        return gate.mode === "stall"
          ? Effect.andThen(
              Effect.sync(() => gate.stalled++),
              Effect.never,
            )
          : gate.mode === "fail"
            ? (Effect.die(new Error("the store broke")) as never)
            : store.lookupMany(keys);
      },
      run: (spec, compute) =>
        store.run(
          spec,
          Effect.andThen(
            Effect.sync(() => computed.push(spec.op)),
            // The head tree's index (its blob chunks), held while `index.held` is set.
            spec.op === "harness.blob-chunks" && index.held !== undefined
              ? Effect.andThen(
                  Effect.sync(() => index.entered++),
                  Effect.andThen(
                    Effect.promise(() => index.held!),
                    compute,
                  ),
                )
              : compute,
          ) as typeof compute,
        ),
    },
  );
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
  const provided = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Computations.ComputationStore | Blobs.BlobStore
    >,
  ) => Effect.runPromise(Effect.provide(effect, records));
  const storeValue = (op: string, value: unknown) =>
    provided(
      Effect.map(
        store.run(
          { op, opVersion: 1, inputs: { root } },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(value)),
            mediaType: "application/json",
          }),
        ),
        (result) => result.computation.key,
      ),
    );

  // The manifest and the plan: one section, f, whose new line 2 changed (and one per `more` file).
  const changed = [
    ...diff("a.ts", F_BASE, F_HEAD),
    ...more.flatMap((name) => diff(`${name}.ts`, fn(name, 1), fn(name, 2))),
  ].map((hunk) => {
    const { leads: _leads, ...rest } = hunk as typeof hunk & {
      leads?: unknown;
    };
    return rest;
  });
  const manifest = {
    ...manifestOf(changed as never),
    range: {
      baseOid,
      headOid,
      mergeBase,
      baseTree: tree(baseOid),
      headTree: tree(headOid),
    },
  };
  const manifestKey = await storeValue("test.range-manifest", manifest);
  const evidencePlan = planReadings({
    hunks: changed as never,
    structures: new Map(
      [
        ["f", F_BASE],
        ["f", F_HEAD],
        ...more.flatMap((name) => [
          [name, fn(name, 1)],
          [name, fn(name, 2)],
        ]),
      ].map(([name, text]) => [
        oidOf(text!),
        symbolStructure(text!, [
          { start: 1, end: 3, kind: "declaration", name: name! },
        ]),
      ]),
    ),
    ...(options.maxItems === undefined
      ? {}
      : { bounds: { maxItems: options.maxItems } }),
  });
  const planKey = await storeValue("test.readings-plan", evidencePlan);

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
  const log: RunLog = {
    path: "(memory)",
    write: (row) => {
      rows.push(row);
    },
    read: () => rows,
  };
  /**
   * A run's context: a new review unless given a run's ID (a resume, in a new process, keeps its
   * cycle) or a cycle (`cycleId`: a follow-on run of that review's sequence, the same run key).
   * `readings`: the section readings' block frozen in, as a request freezes it (`readingsConfig`
   * with no settings); else none. The decision reads nothing of it: the lift is no switch (round 13).
   */
  const cycles = new Map<string, string>();
  const runOf = (
    runId = mintUlid(),
    readings = false,
    cycleId = cycles.get(runId) ?? mintUlid(),
  ) => {
    cycles.set(runId, cycleId);
    const ctx = {
      location,
      repository,
      runId,
      runKey: "f".repeat(64),
      range: { baseRef: "main", baseOid, headOid },
      cycleId,
      config: readings
        ? { ...defaultConfig(), readings: readingsConfig(Option.none()) }
        : defaultConfig(),
      log,
      startedAt: Date.now(),
      reconciliationId: mintUlid(),
      records,
    };
    return { ctx, run: stageRunner(ctx, clients), clients };
  };
  const input = {
    planKey,
    group: evidencePlan.groups[0]!.id,
    manifestKey,
  };
  /** The graph lane's own computation of one commit's relations, as the relations task runs it. */
  const relationsOf = (commit: string) =>
    provided(
      relationsComputation(
        repository,
        commit,
        engine.source,
        relationsGraphDirectory(location),
      ),
    );
  const keyOf = (commit: string) =>
    Computations.computationKey(relationsSpec(commit, engine.source)).key;
  /** Bytes stored under one commit's relations key, as if the relations task had stored them. */
  const storeRelations = (commit: string, value: unknown) =>
    provided(
      store.run(
        relationsSpec(commit, engine.source),
        Effect.succeed({
          bytes: new TextEncoder().encode(JSON.stringify(value)),
          mediaType: "application/json",
        }),
      ),
    ).then((result) => {
      relationHashes.add(result.computation.outputHash);
      return result;
    });
  /** The decision input of the group that reads the section of one path. */
  const groupOf = (path: string) => {
    const key = evidencePlan.sections.find((s) => s.path === path)!.key;
    return {
      planKey,
      manifestKey,
      group: evidencePlan.groups.find((g) => g.keys.includes(key))!.id,
    };
  };
  return {
    engine,
    index,
    manifestKey,
    rows,
    computed,
    gate,
    runOf,
    input,
    plan: evidencePlan,
    relationsOf,
    keyOf,
    storeRelations,
    groupOf,
    reads,
    hunks: new Map(changed.map((hunk) => [hunk.hunkId, hunk])) as typeof hunks,
    commits: { baseOid, mergeBase, headOid },
    section: evidencePlan.sections[0]!.key,
  };
};

const decide = async (
  world: Awaited<ReturnType<typeof reviewWorld>>,
  at = world.runOf(),
) => {
  const started = performance.now();
  const key = await groupEvidence(at.ctx, at.run, world.input);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const evidence = await readEvidence(at.ctx, at.run, key!);
  return { key: key!, evidence, ms: performance.now() - started };
};

// Reason: the readings must never stall behind a relations read.
test("with nothing stored, a read in flight or a failed read, a group decides at once, shows nothing, keeps every gap and starts no read", async () => {
  const world = await reviewWorld();
  const nothingShown: GroupEvidence = {
    recipe: EVIDENCE_RECIPE,
    group: world.input.group,
    outcome: "not-stored",
    relations: { head: null, base: null },
    sections: [{ key: world.section, relations: "not-read", rows: [] }],
  };
  // Nothing stored and no relations task: no engine is started, nothing is waited for.
  const nothing = await decide(world);
  expect(nothing.evidence).toEqual(nothingShown);
  expect(world.engine.spawns()).toEqual([]);
  expect(world.computed).not.toContain("harness.graph-relations");
  expect(nothing.ms).toBeLessThan(EVIDENCE_BOUND_MS);

  // A failed read (the relations task's, here the graph lane's computation) stores nothing: the
  // group shows nothing, and asks for no read of its own.
  world.engine.mode("fail");
  await world.relationsOf(world.commits.headOid).then(
    () => {
      throw new Error("the read was to fail");
    },
    () => undefined,
  );
  expect(world.engine.spawns()).toEqual([world.commits.headOid]);
  const failed = await decide(world);
  expect(failed.evidence).toEqual(nothingShown);
  expect(world.engine.spawns()).toEqual([world.commits.headOid]);

  // The head's read in flight, held by the engine: the group does not wait for it.
  world.engine.mode("gated");
  const reading = world.relationsOf(world.commits.headOid);
  for (let at = 0; at < 2_000 && world.engine.spawns().length < 2; at++)
    await Bun.sleep(5);
  expect(world.engine.spawns()).toHaveLength(2);
  const inFlight = await decide(world);
  expect(inFlight.evidence).toEqual(nothingShown);
  expect(inFlight.ms).toBeLessThan(EVIDENCE_BOUND_MS);
  // Still the one read: the consumer never started a second.
  expect(world.engine.spawns()).toHaveLength(2);
  world.engine.release();
  await reading;
  expect(world.engine.spawns()).toHaveLength(2);
  // Each of the three runs decided its group once.
  expect(
    world.computed.filter((op) => op === "harness.reading-evidence"),
  ).toHaveLength(3);
}, 60_000);

// Reason: two readings judged on different evidence must not be combined as one judgement, and a
// consumer that asks with another base or folder silently never finds the stored answer.
test("a group decides once per run: the other reading, a replay and a resume get the same decision though the relations were stored in between; a new run finds the graph lane's stored reads by the head and the merge base", async () => {
  const world = await reviewWorld();
  const first = world.runOf();
  const before = await decide(world, first);
  expect(before.evidence.sections[0]!.relations).toBe("not-read");

  // The relations become stored, by the computation the relations task runs, for the head and the
  // merge base (the base commit itself is never read).
  await world.relationsOf(world.commits.headOid);
  await world.relationsOf(world.commits.mergeBase);
  expect(world.engine.spawns()).toEqual([
    world.commits.headOid,
    world.commits.mergeBase,
  ]);

  // The same run: the other reading of the group, and a replayed phase, read the stored decision.
  const again = await decide(world, first);
  expect(again.key).toBe(before.key);
  expect(again.evidence).toEqual(before.evidence);
  // A resume in another process (a new context, the same run): the same decision.
  const resumed = await decide(world, world.runOf(first.ctx.runId));
  expect(resumed.key).toBe(before.key);
  expect(resumed.evidence).toEqual(before.evidence);

  // Another review (a new cycle) decides from what is stored now: f's caller, from the head commit, and both stored
  // reads by the graph lane's own key. The fixture engine declares no call lines, so every row
  // shows only its caller (`caller`): the caller's line is its function's first line, and the test
  // file's call outside every function has no line, so it is shown by its path alone (round 9). The
  // section is not shown.
  const later = await decide(world);
  expect(later.key).not.toBe(before.key);
  expect(later.evidence.relations).toEqual({
    head: world.keyOf(world.commits.headOid),
    base: world.keyOf(world.commits.mergeBase),
  });
  expect(later.evidence.relations.base).not.toBe(
    world.keyOf(world.commits.baseOid),
  );
  expect(later.evidence.sections).toEqual([
    {
      key: world.section,
      relations: "partial",
      rows: [
        {
          kind: "caller",
          symbol: "f",
          path: "b.ts",
          shows: "caller",
          line: 2,
          text: "export const g = () => f(1);",
          from: "g",
          confirmed: true,
        },
        {
          kind: "test",
          symbol: "f",
          path: "tests/a.test.ts",
          shows: "caller",
          line: null,
          text: null,
          from: null,
          confirmed: true,
        },
      ],
    },
  ]);
  // No read was started by any decision: the two above are the relations computation's.
  expect(world.engine.spawns()).toHaveLength(2);

  // Every step of the group prepares from that one stored decision: Assess, Lane review, a re-read
  // and a claim check show the same rows.
  const shown = (text: string) =>
    text.split("\n").filter((line) => /^(caller|test) of /.test(line));
  const sources = {
    hunks: new Map(
      diff("a.ts", F_BASE, F_HEAD).map((hunk) => [hunk.hunkId, hunk]),
    ),
    structures: new Map(
      [F_BASE, F_HEAD].map((text) => [
        oidOf(text),
        symbolStructure(text, [
          { start: 1, end: 3, kind: "declaration", name: "f" },
        ]),
      ]),
    ),
    evidence: later.evidence,
  };
  const texts = [
    renderReading(world.plan, world.input.group, { for: "assess", ...sources }),
    renderReading(world.plan, world.input.group, {
      for: "lane-review",
      ...sources,
    }),
    renderReading(world.plan, world.input.group, {
      for: "assess",
      ...sources,
      only: [world.section],
    }),
    renderReading(world.plan, world.input.group, {
      for: "lane-review",
      ...sources,
      only: [world.section],
    }),
  ].map((reading) => shown(reading.text));
  expect(texts[0]).toEqual([
    "caller of f, called from g: b.ts line 2\texport const g = () => f(1);",
    "test of f, called from outside any function: tests/a.test.ts",
  ]);
  for (const text of texts) expect(text).toEqual(texts[0]!);
  expect(readingOrder(world.plan, world.input.group)).toEqual([world.section]);
}, 60_000);

// Reason (round 14, fix 2): a follow-on reuses every completed reading. The evidence is keyed by the
// review's sequence (cycle and run key), not the run, so a follow-on of the same run key is shown
// what the first run was shown, though its relations read failed in the first run and succeeded
// since: the same key, the same rows, no lookup and no new decision, so its readings meet the same
// text and their stored answers are reused. A published batch never moves, whatever evidence comes
// later; another review decides again from what is stored by then.
test("a follow-on of the same sequence is shown the first run's evidence after a relations read failed in it and succeeded since", async () => {
  const world = await reviewWorld();
  const first = world.runOf();
  // The first run's relations read fails: the group is shown nothing.
  world.engine.mode("fail");
  await world.relationsOf(world.commits.headOid).then(
    () => {
      throw new Error("the read was to fail");
    },
    () => undefined,
  );
  const before = await decide(world, first);
  expect(before.evidence.sections[0]!.relations).toBe("not-read");
  // The read succeeds before the follow-on: the relations are now stored.
  world.engine.mode("valid");
  await world.relationsOf(world.commits.headOid);
  await world.relationsOf(world.commits.mergeBase);
  const decisions = () =>
    world.computed.filter((op) => op === "harness.reading-evidence").length;
  const decided = decisions();
  const from = { ...evidenceWork };
  // The follow-on: a new run ID, the same cycle and run key.
  const followOn = world.runOf(undefined, false, first.ctx.cycleId);
  expect(followOn.ctx.runId).not.toBe(first.ctx.runId);
  const again = await decide(world, followOn);
  expect(again.key).toBe(before.key);
  expect(again.evidence).toEqual(before.evidence);
  expect(decisions()).toBe(decided);
  expect(workSince(from)).toEqual({
    lookups: 0,
    callerPaths: 0,
    slices: 0,
    declarations: 0,
  });
  // Another review of the range decides again, and finds the stored relations.
  const other = await decide(world);
  expect(other.key).not.toBe(before.key);
  expect(other.evidence.relations.head).toBe(
    world.keyOf(world.commits.headOid),
  );
}, 60_000);

// Reason: record 0016: one run per key.
test("two reading tasks of one group asking at once end with one stored decision, computed once", async () => {
  const world = await reviewWorld();
  await world.relationsOf(world.commits.headOid);
  const at = world.runOf();
  const [a, b] = await Promise.all([
    groupEvidence(at.ctx, at.run, world.input),
    // The other reading, in the same process but under its own context object.
    (() => {
      const other = world.runOf(at.ctx.runId);
      return groupEvidence(other.ctx, other.run, world.input);
    })(),
  ]);
  expect(a).toBeDefined();
  expect(b).toBe(a);
  expect(
    world.computed.filter((op) => op === "harness.reading-evidence"),
  ).toHaveLength(1);
  const evidence = await readEvidence(at.ctx, at.run, a!);
  // The fixture engine gives f's caller and no line for the test file's call (round 7d).
  expect(evidence.sections[0]!.relations).toBe("partial");
  const reader = world.runOf();
  expect(sha256Hex(JSON.stringify(evidence))).toBe(
    sha256Hex(JSON.stringify(await readEvidence(reader.ctx, reader.run, b!))),
  );
}, 60_000);

// Reason: a decision that stalls must never hold a reading, and must still be one decision.
test("a decision that stalls past its bound stores nothing shown once: the reading that joined it gets the same key, a later one reads it stored, and the work ran once", async () => {
  const world = await reviewWorld();
  await world.relationsOf(world.commits.headOid);
  world.gate.mode = "stall";
  const at = world.runOf();
  const bound = 300;
  const first = groupEvidence(at.ctx, at.run, world.input, undefined, bound);
  for (let wait = 0; wait < 2_000 && world.gate.stalled === 0; wait++)
    await Bun.sleep(5);
  expect(world.gate.stalled).toBe(1);
  // The group's other reading asks while the decision is held: it joins that one run.
  const other = world.runOf(at.ctx.runId);
  const second = groupEvidence(
    other.ctx,
    other.run,
    world.input,
    undefined,
    bound,
  );
  const [a, b] = await Promise.all([first, second]);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(b).toBe(a);
  expect((await readEvidence(at.ctx, at.run, a!)).outcome).toBe("over-bound");
  expect((await readEvidence(at.ctx, at.run, a!)).sections).toEqual([]);
  // Later, with the store answering again, the same run reads the stored decision.
  world.gate.mode = "pass";
  const later = world.runOf(at.ctx.runId);
  expect(await groupEvidence(later.ctx, later.run, world.input)).toBe(a);
  expect(world.gate.stalled).toBe(1);
  expect(
    world.computed.filter((op) => op === "harness.reading-evidence"),
  ).toHaveLength(1);
}, 60_000);

// Reason: an error inside the decision must never fail or hold a reading.
test("an error inside a decision stores nothing shown as failed, never throws, and the reading's key is there to start it", async () => {
  const world = await reviewWorld();
  await world.relationsOf(world.commits.headOid);
  world.gate.mode = "fail";
  const at = world.runOf();
  const key = await groupEvidence(at.ctx, at.run, world.input);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  world.gate.mode = "pass";
  const evidence = await readEvidence(at.ctx, at.run, key!);
  // The store's failure reaches the decision through the graph lane's lookup, which never fails: it
  // says `failed`, and every section of the group is listed as not read.
  expect(evidence).toEqual({
    recipe: EVIDENCE_RECIPE,
    group: world.input.group,
    outcome: "failed",
    relations: { head: null, base: null },
    sections: [{ key: world.section, relations: "not-read", rows: [] }],
  });
  // A section a decision does not list is shown nothing and keeps its gap too.
  expect(sectionEvidence({ ...evidence, sections: [] }, world.section)).toEqual(
    {
      key: world.section,
      relations: "not-read",
      rows: [],
    },
  );
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Round 7: the graph lane's stored lookup, one slicing pass, and the head's declarations per run
// ---------------------------------------------------------------------------------------------

/** The graph lane's calls the decisions made, and the store's relations reads, since `from`. */
const workSince = (
  from: typeof evidenceWork,
): Record<keyof typeof evidenceWork, number> => ({
  lookups: evidenceWork.lookups - from.lookups,
  callerPaths: evidenceWork.callerPaths - from.callerPaths,
  slices: evidenceWork.slices - from.slices,
  declarations: evidenceWork.declarations - from.declarations,
});

/** b.ts and the test file, each calling f and every name once, one call per line from line 2. */
const callerTexts = (names: ReadonlyArray<string>) => ({
  b: `${[
    'import { f } from "./a";',
    ...["f", ...names].map(
      (name) => `export const g_${name} = () => ${name}(1);`,
    ),
  ].join("\n")}\n`,
  test: `${[
    'import { f } from "../a";',
    ...["f", ...names].map((name) => `test("${name}", () => ${name}(1));`),
  ].join("\n")}\n`,
});

/**
 * A head index by the graph lane's builder: f in a.ts and one function per name in `<name>.ts`
 * (lines 1 to 3); `g` in b.ts calls f and each of `called` from line 2 on, and the test file calls
 * them on the same lines; `uncalled` has no caller.
 */
const callersIndex = async (
  called: ReadonlyArray<string>,
  uncalled: ReadonlyArray<string>,
) => {
  const builder = new RelationsIndexBuilder();
  const names = [...called, ...uncalled];
  for (const path of [
    "a.ts",
    "b.ts",
    "tests/a.test.ts",
    ...names.map((name) => `${name}.ts`),
  ])
    builder.file({
      id: `file:${path}`,
      path,
      language: "TypeScript",
      bytes: 1,
    });
  for (const [id, path, end] of [
    ["f", "a.ts", 3],
    ...names.map((name) => [name, `${name}.ts`, 3] as const),
    ["g", "b.ts", called.length + 2],
  ] as const)
    builder.symbol({
      id,
      name: id,
      qualifiedName: id,
      kind: "function",
      language: "TypeScript",
      path,
      startLine: 1,
      endLine: end,
      containerId: null,
      signature: null,
    });
  ["f", ...called].forEach((to, at) => {
    for (const [from, path] of [
      ["g", "b.ts"],
      ["file:tests/a.test.ts", "tests/a.test.ts"],
    ] as const)
      builder.relation({
        relation: "CALLS",
        fromId: from,
        toId: to,
        targetKind: "symbol",
        resolution: "exact",
        confidence: 0.9,
        scope: null,
        evidence: [
          {
            kind: "call_site",
            location: { kind: "point", path: path as SourcePath, line: at + 2 },
            detail: null,
          },
        ],
        warningCodes: [],
        evidenceDropped: 0,
      });
  });
  return futureShape(await builder.finish(coverage()));
};

/** A group's decision for one path's section, in the given run. */
const decideFor = async (
  world: Awaited<ReturnType<typeof reviewWorld>>,
  at: ReturnType<Awaited<ReturnType<typeof reviewWorld>>["runOf"]>,
  path: string,
) => {
  const key = await groupEvidence(at.ctx, at.run, world.groupOf(path));
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  return readEvidence(at.ctx, at.run, key!);
};

// Reason (round 7, point 1): the switch to the graph lane's lookup must keep every outcome a decision
// counts apart, and must still never start a read or wait for one.
test("the stored lookup's outcomes map onto the decision's: nothing stored and no engine are not-stored, an index that does not decode is failed, a read the graph lane's computation stored is read; nothing is started and nothing waits", async () => {
  const world = await reviewWorld();
  const notRead = [{ key: world.section, relations: "not-read", rows: [] }];
  const nothing = await decide(world);
  expect(nothing.evidence).toMatchObject({
    outcome: "not-stored",
    relations: { head: null, base: null },
    sections: notRead,
  });
  // No engine: the lookup says the graph is unavailable on both sides, counted as not stored.
  const engineNow = process.env[ENGINE];
  process.env[ENGINE] = join(tmpdir(), `no-engine-${mintUlid()}`);
  let none: Awaited<ReturnType<typeof decide>>;
  try {
    none = await decide(world);
  } finally {
    process.env[ENGINE] = engineNow;
  }
  expect(none.evidence).toMatchObject({
    outcome: "not-stored",
    relations: { head: null, base: null },
    sections: notRead,
  });
  // The merge base stored by the graph lane's computation, the head not: not stored, the base
  // recorded.
  await world.relationsOf(world.commits.mergeBase);
  const baseOnly = await decide(world);
  expect(baseOnly.evidence).toMatchObject({
    outcome: "not-stored",
    relations: { head: null, base: world.keyOf(world.commits.mergeBase) },
    sections: notRead,
  });
  // Bytes under the head's key that are no index: failed, and nothing shown.
  await world.storeRelations(world.commits.headOid, { not: "an index" });
  const broken = await decide(world);
  expect(broken.evidence).toMatchObject({
    outcome: "failed",
    relations: { head: null, base: world.keyOf(world.commits.mergeBase) },
    sections: notRead,
  });
  // No decision started a read: the one spawn is the base's computation above.
  expect(world.engine.spawns()).toEqual([world.commits.mergeBase]);
  for (const decided of [nothing, none, baseOnly, broken])
    expect(decided.ms).toBeLessThan(EVIDENCE_BOUND_MS);

  // The head's read, stored by the graph lane's own computation, is found and read.
  const stored = await reviewWorld();
  await stored.relationsOf(stored.commits.headOid);
  const found = await decide(stored);
  expect(found.evidence.outcome).toBe("read");
  expect(found.evidence.relations).toEqual({
    head: stored.keyOf(stored.commits.headOid),
    base: null,
  });
  // Its caller's row and the test file's lineless row are shown; nothing is `shown`, as the
  // fixture engine places no call.
  expect(found.evidence.sections[0]!.relations).toBe("partial");
  expect(
    found.evidence.sections[0]!.rows.map((r) => [r.kind, r.shows]),
  ).toEqual([
    ["caller", "caller"],
    ["test", "caller"],
  ]);
  expect(stored.engine.spawns()).toEqual([stored.commits.headOid]);
}, 60_000);

// Reason (round 7, point 3): a decision must cut the slices once, with the test files known, and show
// the rows the index gives.
test("a decision makes one lookup, one caller-paths pass and, the first in its run, one slicing pass, and shows the caller's row the engine gives", async () => {
  const world = await reviewWorld();
  await world.relationsOf(world.commits.headOid);
  await world.relationsOf(world.commits.mergeBase);
  const from = { ...evidenceWork };
  const reads = world.reads.relations;
  const later = await decide(world);
  expect(workSince(from)).toEqual({
    lookups: 1,
    callerPaths: 1,
    slices: 1,
    declarations: 1,
  });
  // The lookup asks the store for the head's index and then the base's.
  expect(world.reads.relations - reads).toBe(2);
  // The caller's row, as round 6 showed it, naming its function; the test file's call has no line
  // (round 7d's fixture engine), so its row shows only its caller (round 9), and the section is
  // `partial`.
  expect(later.evidence.sections).toEqual([
    {
      key: world.section,
      relations: "partial",
      rows: [
        {
          kind: "caller",
          symbol: "f",
          path: "b.ts",
          shows: "caller",
          line: 2,
          text: "export const g = () => f(1);",
          from: "g",
          confirmed: true,
        },
        {
          kind: "test",
          symbol: "f",
          path: "tests/a.test.ts",
          shows: "caller",
          line: null,
          text: null,
          from: null,
          confirmed: true,
        },
      ],
    },
  ]);
}, 60_000);

// Reason (round 7, N-k): every package manifest of the head tree was read once per group decision,
// even for a group with no caller to classify.
test("the head's declarations are read once per run in a process: two groups' decisions read the manifests once, a group with no caller to classify reads none, and a resumed run in a new process reads once again", async () => {
  const world = await reviewWorld({
    more: ["c", "d", "e"],
    texts: callerTexts(["d", "e"]),
    maxItems: 1,
  });
  expect(world.plan.groups).toHaveLength(4);
  await world.storeRelations(
    world.commits.headOid,
    await callersIndex(["d", "e"], ["c"]),
  );
  const from = { ...evidenceWork };
  const first = world.runOf(undefined, true);
  // c has no caller: nothing to classify, nothing read.
  const c = await decideFor(world, first, "c.ts");
  expect(c.outcome).toBe("read");
  expect(c.sections.map((s) => s.relations)).toEqual(["no-evidence"]);
  expect(workSince(from)).toEqual({
    lookups: 1,
    callerPaths: 1,
    slices: 1,
    declarations: 0,
  });
  // a and d: one read between them.
  for (const path of ["a.ts", "d.ts"]) {
    const shown = await decideFor(world, first, path);
    expect(shown.sections.map((s) => s.relations)).toEqual(["shown"]);
    expect(shown.sections[0]!.rows.map((r) => [r.kind, r.path])).toEqual([
      ["caller", "b.ts"],
      ["test", "tests/a.test.ts"],
    ]);
  }
  // a cuts the plan's slices for the run (c cut its own section only); d takes them.
  expect(workSince(from)).toEqual({
    lookups: 3,
    callerPaths: 3,
    slices: 2,
    declarations: 1,
  });
  // The same run resumed in a new process (a new context): the memories are gone, one read and
  // one cut again.
  const resumed = world.runOf(first.ctx.runId, true);
  const e = await decideFor(world, resumed, "e.ts");
  expect(e.sections.map((s) => s.relations)).toEqual(["shown"]);
  expect(workSince(from)).toEqual({
    lookups: 4,
    callerPaths: 4,
    slices: 3,
    declarations: 2,
  });
}, 60_000);

// Reason (round 7, test 9): a decode per decision cost 39 s and gigabytes on a real index; it must
// not come back unnoticed.
test("group decisions started at the same moment make one lookup and one caller-paths pass each, share one slicing pass, and read the head's declarations once", async () => {
  const called = ["c", "d", "e", "h", "i", "j", "k"];
  const world = await reviewWorld({
    more: called,
    texts: callerTexts(called),
    maxItems: 1,
  });
  const decisions = world.plan.groups.length;
  expect(decisions).toBe(8);
  const index = await callersIndex(called, []);
  await world.storeRelations(world.commits.headOid, index);
  await world.storeRelations(world.commits.mergeBase, index);
  const from = { ...evidenceWork };
  const reads = { ...world.reads };
  const decodesBefore = Effect.runSync(relationsIndexDecodes);
  const at = world.runOf(undefined, true);
  const all = await Promise.all(
    ["a.ts", ...called.map((name) => `${name}.ts`)].map((path) =>
      decideFor(world, at, path),
    ),
  );
  for (const decided of all) {
    expect(decided.outcome).toBe("read");
    expect(decided.relations).toEqual({
      head: world.keyOf(world.commits.headOid),
      base: world.keyOf(world.commits.mergeBase),
    });
    expect(decided.sections.map((s) => s.relations)).toEqual(["shown"]);
  }
  // One lookup and one caller-paths pass per decision (each tells whether its group has a caller
  // to classify); the plan's slices cut once for all of them.
  expect(workSince(from)).toEqual({
    lookups: decisions,
    callerPaths: decisions,
    slices: 1,
    declarations: 1,
  });
  // The stored relations outputs, read through the world's one blob service object as production
  // reads them through the run's: the head's and the base's, each read and decoded once for all the
  // decisions (the graph lane's shared load). Each lookup still reads the computation's row
  // (`keys`, two per decision), which is not the output.
  const relationReads = {
    outputs: world.reads.outputs - reads.outputs,
    keys: world.reads.relations - reads.relations,
    decodes: Effect.runSync(relationsIndexDecodes) - decodesBefore,
  };
  console.log(
    `relations output reads for ${decisions} decisions: ${JSON.stringify(relationReads)}`,
  );
  expect(relationReads.outputs).toBeLessThanOrEqual(2);
  expect(relationReads.decodes).toBeLessThanOrEqual(2);
  // A decision started after those have finished (another run, so it decides afresh) reads the
  // stored outputs no further: the decoded indexes are held.
  const after = { ...world.reads };
  const decodesAfter = Effect.runSync(relationsIndexDecodes);
  const later = await decideFor(world, world.runOf(undefined, true), "a.ts");
  expect(later.sections.map((s) => s.relations)).toEqual(["shown"]);
  console.log(
    `relations output reads for one decision afterwards: ${JSON.stringify({
      outputs: world.reads.outputs - after.outputs,
      keys: world.reads.relations - after.relations,
      decodes: Effect.runSync(relationsIndexDecodes) - decodesAfter,
    })}`,
  );
  expect(world.reads.outputs - after.outputs).toBe(0);
  expect(Effect.runSync(relationsIndexDecodes) - decodesAfter).toBe(0);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Round 13: the lift is no switch, through the real stored lookup
// ---------------------------------------------------------------------------------------------

// Reason (round 13, the owner's ruling: no A/B): with no setting the lift is on. A run with no
// readings block and one with the block a request freezes decide the same, and an index whose rows
// show calls is shown.
test("through the real stored lookup, with no setting an index whose rows show calls is shown, whatever the run's readings block; the decision's key has no switch", async () => {
  const world = await reviewWorld({
    more: ["c", "d", "e"],
    texts: callerTexts(["d", "e"]),
    maxItems: 1,
  });
  await world.storeRelations(
    world.commits.headOid,
    await callersIndex(["d", "e"], ["c"]),
  );
  for (const at of [world.runOf(), world.runOf(undefined, true)]) {
    const states: Array<string> = [];
    for (const path of ["a.ts", "c.ts", "d.ts", "e.ts"]) {
      const decided = await decideFor(world, at, path);
      expect(decided.outcome).toBe("read");
      states.push(...decided.sections.map((s) => s.relations));
    }
    expect(states).toEqual(["shown", "no-evidence", "shown", "shown"]);
  }
  // The key's inputs: the sequence, plan, group, manifest and recipe; no switch.
  const spec = {
    cycleId: "c",
    runKey: "k",
    planKey: "p",
    group: "g",
    manifestKey: "m",
  };
  expect(Object.keys(evidenceSpec(spec).inputs as object).sort()).toEqual([
    "group",
    "manifest",
    "plan",
    "recipe",
    "sequence",
  ]);
}, 60_000);

// Reason (round 13): the old switch must no longer decide anything. A settings file or a frozen
// configuration that names it is still accepted, and it changes neither the frozen block nor the
// run key.
test("the old switch is ignored: set or not, the readings block and the run key are the default's; a configuration frozen with it still parses", () => {
  const settingsOf = (review: NonNullable<Settings["review"]>) =>
    Option.some<Settings>({ version: 1, review });
  const range = {
    baseRef: "main",
    baseOid: "1".repeat(40),
    headOid: "2".repeat(40),
  };
  const keyWith = (block: ReturnType<typeof readingsConfig>) =>
    runKeyFor(
      range,
      defaultConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        block,
      ),
    );
  const absent = readingsConfig(settingsOf({}));
  expect(absent).toEqual({
    mode: "probe",
    bounds: { ...DEFAULT_READING_BOUNDS },
    recipe: READING_RECIPE,
  });
  expect(JSON.stringify(readingsConfig(Option.none()))).toBe(
    JSON.stringify(absent),
  );
  for (const value of [true, false]) {
    const set = readingsConfig(
      settingsOf({ sectionReadingsCallsLiftGap: value }),
    );
    expect(JSON.stringify(set)).toBe(JSON.stringify(absent));
    expect(keyWith(set)).toBe(keyWith(absent));
  }
  // A configuration frozen before this round, with the switch in its block, still parses.
  const frozen = defaultConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ...absent!, callsLiftGap: true },
  );
  expect(PipelineConfig.parse(frozen).readings?.callsLiftGap).toBe(true);
  // With the readings off it freezes nothing, and the run keeps the key it had.
  expect(
    readingsConfig(
      settingsOf({ sectionReadings: "off", sectionReadingsCallsLiftGap: true }),
    ),
  ).toBeUndefined();
  expect(keyWith(undefined)).toBe(PARENT.runKeyOff);
  // Beside scope and tests, only scope and tests is frozen.
  const scoped = readingsConfig(
    settingsOf({
      sectionReadings: "probe",
      sectionReadingsScopeAndTests: true,
      sectionReadingsCallsLiftGap: true,
    }),
  );
  expect(scoped).toMatchObject({ scopeAndTests: true });
  expect(scoped).not.toHaveProperty("callsLiftGap");
});

/** Head texts for the real engine: a caller whose call is on its third line, and two test files. */
const REAL_B =
  'import { f } from "./a";\nexport function g() {\n  const n = 1;\n  return f(n);\n}\n';
const REAL_TESTS = {
  /** The test calls f from a named function, called inside `test(...)`. */
  named:
    'import { f } from "../a";\nfunction check() {\n  const n = 1;\n  return f(n);\n}\ntest("f", () => expect(check()).toBe(3));\n',
  /** The test calls f inside the `test(...)` callback itself. */
  inCallback:
    'import { f } from "../a";\ntest("f", () => {\n  expect(f(1)).toBe(3);\n});\n',
};

/** One review world read by the real engine, its head's relations stored by the graph lane's own
 * computation, and one group decision made as production makes it (no override). */
const realDecision = async (test: string) => {
  const world = await reviewWorld({ texts: { b: REAL_B, test }, real: true });
  await world.relationsOf(world.commits.headOid);
  const decided = await decide(world);
  return { world, evidence: decided.evidence };
};

/** The 1-based line of `text` that holds `needle`, read from the text, never written as a number. */
const lineOf = (text: string, needle: string) => {
  const at = text.split("\n").findIndex((line) => line.includes(needle));
  if (at === -1) throw new Error(`no line holds ${needle}`);
  return at + 1;
};

// Reason (the standing rule that a round consuming the graph lane's data runs the real engine on a
// real repository; round 13, no A/B): with no setting, a section whose symbol has a trusted caller
// row showing its call, from a declared not-test file, loses its gap and takes the rule's lane.
test.skipIf(realEngine.skip)(
  "on the real engine with no setting, a section whose symbol has a trusted caller row showing its call is shown, loses its gap and takes the rule's lane",
  async () => {
    realEngine.require();
    const { world, evidence } = await realDecision(REAL_TESTS.named);
    expect(evidence.outcome).toBe("read");
    const section = evidence.sections.find((s) => s.key === world.section)!;
    expect(section.rows.map((r) => [r.kind, r.confirmed, r.shows])).toEqual([
      ["caller", true, "call"],
      ["test", true, "call"],
    ]);
    expect(section.rows.some((r) => r.undecided !== undefined)).toBe(false);
    expect(section.relations).toBe("shown");
    expect(decidedX(world.plan, world.hunks, evidence, world.section)).toBe(
      false,
    );
    expect(laneX(world.plan, world.hunks, evidence, world.section)).toBe(
      "static-automation",
    );
  },
  180_000,
);

// Reason (round 7d, changed on purpose in round 9): what a row shows must be what the reading says it
// shows. The engine now gives the call's own line and says so (`call_site_lines`), so the assertions
// on each row's line and text moved from the calling function's first line ("export function g() {",
// "function check() {") to the call's line, read from the texts here, each row now says what its
// line shows (`shows` `call`), the reading says "called here" in place of "called from <function>",
// and the call inside a test(...) callback, which had no line, now gives a test row at its line.
test.skipIf(realEngine.skip)(
  "on the real engine, a function caller's row shows its call's own line and text, marked call; a named function in a test file and a call inside a test(...) callback each give a test row at the call",
  async () => {
    realEngine.require();
    const named = await realDecision(REAL_TESTS.named);
    const call = lineOf(REAL_B, "return f(n);");
    const checked = lineOf(REAL_TESTS.named, "return f(n);");
    expect(
      named.evidence.sections.find((s) => s.key === named.world.section)!.rows,
    ).toEqual([
      {
        kind: "caller",
        symbol: "f",
        path: "b.ts",
        shows: "call",
        line: call,
        text: "return f(n);",
        from: "g",
        confirmed: true,
      },
      {
        kind: "test",
        symbol: "f",
        path: "tests/a.test.ts",
        shows: "call",
        line: checked,
        text: "return f(n);",
        from: "check",
        confirmed: true,
      },
    ]);
    // The reading says so.
    const reading = renderReading(named.world.plan, named.world.input.group, {
      for: "assess",
      hunks: named.world.hunks,
      structures: new Map(),
      evidence: named.evidence,
    });
    expect(
      reading.text
        .split("\n")
        .filter((line) => /^(caller|test) of /.test(line)),
    ).toEqual([
      `caller of f, called here: b.ts line ${call}\treturn f(n);`,
      `test of f, called here: tests/a.test.ts line ${checked}\treturn f(n);`,
    ]);
    expect(reading.text).toContain(EVIDENCE_LEGEND.tests);
    // The call inside the callback is the file's: a test row at the call's line.
    const inCallback = await realDecision(REAL_TESTS.inCallback);
    const section = inCallback.evidence.sections.find(
      (s) => s.key === inCallback.world.section,
    )!;
    expect(
      section.rows.map((r) => [
        r.kind,
        r.path,
        r.shows,
        r.line,
        r.text,
        r.from,
      ]),
    ).toEqual([
      ["caller", "b.ts", "call", call, "return f(n);", "g"],
      [
        "test",
        "tests/a.test.ts",
        "call",
        lineOf(REAL_TESTS.inCallback, "expect(f(1))"),
        "expect(f(1)).toBe(3);",
        null,
      ],
    ]);
    // b.ts's trusted call lifts with no setting (round 13): the lift is no switch.
    expect(section.relations).toBe("shown");
  },
  180_000,
);

// ---------------------------------------------------------------------------------------------
// The readings wait on the head gate (round 20)
// ---------------------------------------------------------------------------------------------

/** A promise and its resolver. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Rejects once the signal aborts: what a stand-in task waits on so pi can stop it. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });

/**
 * The world's group read by the production reading task on a real pi Harness, stored in SQLite so
 * a test can stop the worker and open it again, with stand-ins around it:
 * - the head gate: graph's own (`headGateOf` over `relationsTask`, owned by a stand-in review that
 *   can mark its packet published), or, given `standIn`, a stand-in that ends as the test tells it
 *   (`endGate`); either may be stopped (`stopGate`);
 * - the reads (the relations task without the gate: head, then the merge base), which never end
 *   here: no reading may wait for them;
 * - the front task, ending with both keys when the test releases it (`releaseFront`);
 * - the model step, which records the evidence key it was given and ends `skipped`, so no model is
 *   called and the reading ends with no judgement.
 * Each `open` is one worker over the same storage, as a restart is; `wrap` changes the reading's
 * phases for that worker only.
 */
const gatedWorld = async (
  world: Awaited<ReturnType<typeof reviewWorld>>,
  at: ReturnType<(typeof world)["runOf"]>,
) => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  roots.push(root);
  const storage = join(root, "pi.sqlite");
  const shown: Array<{
    readonly kind: string;
    readonly part: string;
    readonly evidence: string | null;
  }> = [];
  let gateEnd = deferred<TaskOutcome<RelationsResult>>();
  let frontEnd = deferred<void>();
  const step = defineTask<AgentStepInput, { phase: "run" }, StageRecord>({
    name: "test.reading-step",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, c) => {
        const params = task.input.params as {
          part?: string;
          evidence?: string;
        };
        shown.push({
          kind: task.input.kind,
          part: params.part ?? "?",
          evidence: params.evidence ?? null,
        });
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                stage: "verify",
                agent: `${task.input.kind}.stand-in`,
                status: "skipped",
                wallMs: 0,
              },
            },
          }),
          c,
        );
      },
    },
    abort: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        c,
      ),
  });
  const stopped = (reason: string) =>
    ({
      status: "terminal",
      outcome: {
        status: "aborted",
        reason,
        result: { status: "stopped" },
      },
    }) as const;
  const gate = defineTask<
    { readonly gate: boolean },
    { phase: "run" },
    RelationsResult
  >({
    name: "test.head-gate",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, c) => {
        const outcome = await Promise.race([
          gateEnd.promise,
          untilAborted(runtime.signal),
        ]);
        await runtime.commit(() => ({ status: "terminal", outcome }), c);
      },
    },
    abort: (_task, runtime, c) => runtime.commit(() => stopped("stopped"), c),
  });
  /** The review the real gate belongs to: it runs until the harness closes. */
  const review = defineTask<object, { phase: "run" }, object>({
    name: "test.review",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime) => {
        await untilAborted(runtime.signal);
      },
    },
    abort: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        c,
      ),
  });
  const reads = defineTask<object, { phase: "run" }, RelationsResult>({
    name: "test.relations-reads",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime) => {
        await untilAborted(runtime.signal);
      },
    },
    abort: (_task, runtime, c) => runtime.commit(() => stopped("stopped"), c),
  });
  const front = defineTask<object, { phase: "run" }, FrontResult>({
    name: "test.front",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, c) => {
        await Promise.race([frontEnd.promise, untilAborted(runtime.signal)]);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                frameKey: "front-frame",
                mapKey: "front-map",
              } as FrontResult,
            },
          }),
          c,
        );
      },
    },
    abort: (_task, runtime, c) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        c,
      ),
  });
  const services = (of: typeof at): StageServices => ({
    ctx: of.ctx,
    runtimes: testRuntimes().registry,
    routes: {
      bindAgentRoute: () => {
        throw new Error("no model step runs here");
      },
      prepareFinalGeneration: () => {
        throw new Error("no model step runs here");
      },
    },
    capture: () => {},
    registry: createRegistry(),
    integrations: { status: "absent", path: "(none)" },
    clients: of.clients,
    run: of.run,
    endRound: async () => {},
  });
  let harness: Harness | undefined;
  let gateOf: (
    tx: Tx,
    cutoffAt: number,
    owner: TaskId,
  ) => Promise<TaskId<RelationsResult>> = () => {
    throw new Error("the harness is not open");
  };
  const open = async (
    of: typeof at = at,
    wrap: (
      task: ReturnType<typeof readingTask>,
    ) => ReturnType<typeof readingTask> = (task) => task,
  ) => {
    gateEnd = deferred();
    frontEnd = deferred();
    const registry = createRegistry();
    const reading = wrap(
      readingTask(
        services(of),
        step as unknown as Parameters<typeof readingTask>[1],
      ),
    );
    const relations = relationsTask(services(of));
    registry.install(
      defineExtension({
        name: "test.gated-readings",
        tasks: [reading, step, gate, reads, front, review, relations],
      }),
    );
    gateOf = (tx, cutoffAt, owner) =>
      headGateOf(relations, of.ctx)(
        tx,
        { manifest: world.manifestKey, cutoffAt },
        owner,
      );
    harness = await Harness.open(
      await openNodeSqliteStorage(storage),
      {
        models: createModels(),
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    harness.resume();
    return { harness, reading };
  };
  /**
   * A worker with the review's real stages installed (`reviewStages`, the run's readings block
   * frozen in `of`): the real readings plan task with the real readings port, the real reading
   * task, graph's relations task and its head gate. Only the review and the front task are
   * stand-ins; `startReview` creates the gate and the plan as the review's precompute commit does.
   */
  const openStages = async (of: typeof at) => {
    gateEnd = deferred();
    frontEnd = deferred();
    const registry = createRegistry();
    const stages = reviewStages({ ...services(of), registry });
    registry.install(stages.extension);
    registry.install(
      defineExtension({
        name: "test.review-stand-ins",
        tasks: [front, review],
      }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(storage),
      {
        models: createModels(),
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    harness.resume();
    const h = harness;
    const startReview = async () => {
      const conversation = await h.root(context);
      const owner = {
        ownership: { kind: "conversation" } as const,
        conversationId: conversation.id,
      };
      return h.commit(async (tx) => {
        const r0 = await tx.createTask(review, {}, owner);
        const f = (await tx.createTask(
          front,
          {},
          owner,
        )) as TaskId<FrontResult>;
        const cutoffAt = Date.now() + 600_000;
        // As `review-task.ts` does in the precompute commit: the head gate, then the readings' plan
        // given the front task and the gate, both owned by the review.
        const g = await stages.headGate!(
          tx,
          { manifest: world.manifestKey, cutoffAt },
          r0,
        );
        const plan = (await stages.readingsPlan!(
          tx,
          {
            manifestKey: world.manifestKey,
            cutoffAt,
            front: f,
            relations: g,
          },
          r0,
        )) as TaskId<ReadingsPlanResult>;
        return { review: r0, front: f, gate: g, plan };
      }, context);
    };
    return { harness: h, stages, startReview };
  };
  const current = () => {
    if (harness === undefined) throw new Error("the harness is not open");
    return harness;
  };
  /**
   * Creates the gate, the reads and the front task, and the group's two readings given them (the
   * early form: the front task in place of the Frame and Map keys), in one commit, as the plan does.
   * `gated: false` gives the readings no gate, as a review with readings off or an older build.
   */
  const create = async (
    reading: ReturnType<typeof readingTask>,
    options: {
      readonly gated?: boolean;
      /** The stand-in gate; absent, graph's own, with this cut-off (10 minutes by default). */
      readonly standIn?: boolean;
      readonly gateCutoffAt?: number;
    } = {},
  ) => {
    const h = current();
    const conversation = await h.root(context);
    const owner = {
      ownership: { kind: "conversation" } as const,
      conversationId: conversation.id,
    };
    return h.commit(async (tx) => {
      const r0 = await tx.createTask(review, {}, owner);
      const g =
        options.standIn === true
          ? await tx.createTask(gate, { gate: true }, owner)
          : await gateOf(tx, options.gateCutoffAt ?? Date.now() + 600_000, r0);
      const r = await tx.createTask(reads, {}, owner);
      const f = await tx.createTask(front, {}, owner);
      const group = world.plan.groups[0]!;
      const readings = {} as Record<
        "assess" | "lane-review",
        TaskId<ReadingTaskResult>
      >;
      for (const kind of ["assess", "lane-review"] as const) {
        const input: ReadingTaskInput = {
          kind,
          planKey: world.input.planKey,
          group: group.id,
          rank: group.rank,
          manifestKey: world.input.manifestKey,
          cutoffAt: Date.now() + 120_000,
          front: Number(f),
          ...(options.gated === false ? {} : { relations: Number(g) }),
        };
        readings[kind] = (await tx.createTask(
          reading,
          input,
          owner,
        )) as TaskId<ReadingTaskResult>;
      }
      return { review: r0, gate: g, reads: r, front: f, readings };
    }, context);
  };
  const stateOf = (task: TaskId) =>
    current().commit(async (tx) => (await tx.task(task))?.state, context);
  /** Looks (bounded) until the task's state is `status`. */
  const until = async (task: TaskId, status: string) => {
    for (let at = 0; at < 1_000; at++) {
      if ((await stateOf(task))?.status === status) return stateOf(task);
      await Bun.sleep(10);
    }
    throw new Error(`task ${Number(task)} never became ${status}`);
  };
  return {
    open,
    openStages,
    create,
    stateOf,
    until,
    shown,
    endGate: (outcome: TaskOutcome<RelationsResult>) =>
      gateEnd.resolve(outcome),
    stopGate: (task: TaskId) => current().abortTask(task, context),
    /** Marks the review's packet published, as the review's completing commit does. */
    publish: (task: TaskId) =>
      current().commit(async (tx) => {
        await markReviewPublished(tx, task);
        return undefined;
      }, context),
    releaseFront: () => frontEnd.resolve(),
    close: async () => {
      await current().close(context);
      harness = undefined;
    },
    services,
  };
};

/** The head side as a gate's result names it. */
const headSide = (
  world: Awaited<ReturnType<typeof reviewWorld>>,
  outcome: RelationsSideEnd["outcome"],
  wallMs: number,
): RelationsSideEnd => ({
  commit: world.commits.headOid,
  key: world.keyOf(world.commits.headOid),
  outcome,
  wallMs,
});

const decisions = (world: Awaited<ReturnType<typeof reviewWorld>>) =>
  world.computed.filter((op) => op === "harness.reading-evidence").length;

// Reason: the wait must never hang and must decide with what there is. Each terminal end of graph's
// own head gate wakes both readings of the group; they decide once, from what is stored by then,
// and record how the gate ended. Assess waits on the gate alone, and a Lane review given no keys on
// the front task and the gate both; neither waits on the reads, which read the merge base too.
test("each end of the head gate wakes the group's two readings, which decide once from what is stored by then: stored shows the head's caller rows; failed, cut off, published or stopped give their gap's cause", async () => {
  type End = {
    readonly name: string;
    /** The engine's mode while the gate reads; `hold` holds the head tree's index. */
    readonly mode: "valid" | "gated" | "fail" | "hold";
    /** The gate's own cut-off, from now. */
    readonly bound?: number;
    /** What ends the gate other than its read or its bound: the review's stop or publish. */
    readonly by?: "stop" | "publish";
    readonly status: HeadGateEnd["status"];
    readonly cause: RelationsGapCause;
  };
  // In this order: the first builds the head tree's index; the engine is held from the second on,
  // and released only for the last, which stores the head.
  const ends: ReadonlyArray<End> = [
    { name: "failed", mode: "fail", status: "failed", cause: "unavailable" },
    {
      name: "cut off while reading",
      mode: "gated",
      bound: 2_000,
      status: "cutoff",
      cause: "computing",
    },
    {
      name: "published",
      mode: "gated",
      by: "publish",
      status: "published",
      cause: "published",
    },
    {
      name: "stopped",
      mode: "gated",
      by: "stop",
      status: "stopped",
      cause: "stopped",
    },
    // The head read: the section's own state names it (the fixture engine's rows show only their
    // caller, so it is partial).
    { name: "stored", mode: "valid", status: "stored", cause: "partial" },
  ];
  /** One end in its own run (a new review) of `world`. */
  const runEnd = async (
    world: Awaited<ReturnType<typeof reviewWorld>>,
    each: End,
  ) => {
    if (each.mode === "hold") world.index.held = new Promise(() => {});
    else world.engine.mode(each.mode);
    if (each.mode === "valid") world.engine.release();
    const at = world.runOf();
    const gated = await gatedWorld(world, at);
    const { reading } = await gated.open();
    const spawned = world.engine.spawns().length;
    const ids = await gated.create(reading, {
      gateCutoffAt: Date.now() + (each.bound ?? 600_000),
    });
    const before = decisions(world);
    // Both park: Assess on the gate alone, the Lane review on the front task and the gate, and
    // neither on the reads. No step and no decision yet: a waiting task holds no invocation.
    const assess = await gated.until(ids.readings.assess, "waiting");
    const review = await gated.until(ids.readings["lane-review"], "waiting");
    expect([each.name, assess?.status === "waiting" && assess.on]).toEqual([
      each.name,
      [ids.gate],
    ]);
    expect(review?.status === "waiting" && review.on).toEqual([
      ids.front,
      ids.gate,
    ]);
    expect(assess?.checkpoint).toEqual({ phase: "relations" });
    expect(gated.shown).toEqual([]);
    expect(decisions(world)).toBe(before);
    if (each.mode === "gated") {
      // The gate's read of the head is in flight, held by the engine.
      for (let wait = 0; wait < 1_000; wait++) {
        if (world.engine.spawns().length > spawned) break;
        await Bun.sleep(10);
      }
      expect(world.engine.spawns().slice(spawned)).toEqual([
        world.commits.headOid,
      ]);
      expect((await gated.stateOf(ids.readings.assess))?.status).toBe(
        "waiting",
      );
    }
    if (each.by === "stop") await gated.stopGate(ids.gate);
    if (each.by === "publish") await gated.publish(ids.review);
    // Assess wakes and reads though the front task still runs; the Lane review waits for it too.
    await gated.until(ids.readings.assess, "terminal");
    expect((await gated.stateOf(ids.readings["lane-review"]))?.status).toBe(
      "waiting",
    );
    gated.releaseFront();
    await gated.until(ids.readings["lane-review"], "terminal");
    const gateEnd = (await gated.stateOf(ids.gate))?.outcome;
    // The gate reads the head alone, and the reads still run: nothing waited for the merge base.
    expect(
      (gateEnd as { result?: RelationsResult } | undefined)?.result?.base,
    ).toBeUndefined();
    expect((await gated.stateOf(ids.reads))?.status).toBe("running");
    const results = await Promise.all(
      (["assess", "lane-review"] as const).map(async (kind) => {
        const state = await gated.stateOf(ids.readings[kind]);
        expect(state?.outcome?.status).toBe("completed");
        return (state!.outcome as { result: ReadingTaskResult }).result;
      }),
    );
    await gated.close();
    // One decision for the group, shown to both reads.
    expect(decisions(world)).toBe(before + 1);
    const key = results[0]!.evidence!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(results[1]!.evidence).toBe(key);
    expect(gated.shown.map((s) => [s.kind, s.part, s.evidence])).toEqual([
      ["assess", "read", key],
      ["lane-review", "read", key],
    ]);
    const evidence = await readEvidence(at.ctx, at.run, key);
    // The decision records the gate's end as the gate's result gives it.
    expect(evidence.gate).toEqual(
      headGateEndOf(gateEnd as TaskOutcome<RelationsResult>),
    );
    expect([each.name, evidence.gate?.status]).toEqual([
      each.name,
      each.status,
    ]);
    expect([
      each.name,
      relationsGapCause(
        evidence,
        evidence.sections[0]?.relations ?? "not-read",
      ),
    ]).toEqual([each.name, each.cause]);
    return evidence;
  };
  const world = await reviewWorld();
  for (const each of ends) {
    const evidence = await runEnd(world, each);
    if (each.status === "cutoff")
      // Its read had started: the wall time says so.
      expect(evidence.gate?.wallMs).toBeGreaterThan(0);
    if (each.status === "stored") {
      // Computed by the gate during the review, not stored first: the head's caller rows are shown.
      expect(evidence.outcome).toBe("read");
      expect(evidence.relations.head).toBe(world.keyOf(world.commits.headOid));
      expect(
        evidence.sections[0]!.rows.map((row) => [row.kind, row.path]),
      ).toEqual([
        ["caller", "b.ts"],
        ["test", "tests/a.test.ts"],
      ]);
    } else {
      expect(evidence.outcome).toBe("not-stored");
      expect(evidence.sections).toEqual([
        { key: world.section, relations: "not-read", rows: [] },
      ]);
    }
  }
  // Cut off while the head tree's index was still being built: the head's read never started (wall
  // time 0, no engine), and the gap says the callers had not started being computed.
  const fresh = await reviewWorld();
  const unstarted = await runEnd(fresh, {
    name: "cut off before its read",
    mode: "hold",
    bound: 1_000,
    status: "cutoff",
    cause: "not-started",
  });
  expect(fresh.index.entered).toBeGreaterThan(0);
  expect(unstarted.gate?.wallMs).toBe(0);
  expect(fresh.engine.spawns()).toEqual([]);
  // A gate pi failed or stopped with no result reads as failed or stopped.
  expect(
    headGateEndOf({ status: "failed", error: { message: "the gate broke" } }),
  ).toEqual({ status: "failed", wallMs: null });
  expect(headGateEndOf({ status: "aborted", reason: "stopped" })).toEqual({
    status: "stopped",
    wallMs: null,
  });
}, 180_000);

// Reason: readings off, older reviews and tests must stay as they are. With no gate a reading never
// enters the wait, and its decision is the one a reading made before the gate, byte for byte; a
// gate that already ended (the usual local case, its head stored first) waits for nothing either.
test("with no head gate a reading does not wait and decides as before, byte for byte; a gate that already ended waits for nothing and is recorded", async () => {
  const world = await reviewWorld();
  await world.relationsOf(world.commits.headOid);
  /** Counts the times the `relations` phase runs. */
  const counting =
    (count: { n: number }) =>
    (task: ReturnType<typeof readingTask>): ReturnType<typeof readingTask> => {
      const relations = task.definition.phases.relations;
      return {
        ...task,
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            relations: async (t, runtime, c) => {
              count.n++;
              return relations(t, runtime, c);
            },
          },
        },
      };
    };
  // No gate in the readings' input.
  const plain = world.runOf();
  const none = { n: 0 };
  const ungated = await gatedWorld(world, plain);
  const { reading } = await ungated.open(plain, counting(none));
  const ids = await ungated.create(reading, { gated: false });
  // The Lane review still waits on the front task alone, as before.
  const review = await ungated.until(ids.readings["lane-review"], "waiting");
  expect(review?.status === "waiting" && review.on).toEqual([ids.front]);
  expect(review?.checkpoint).toEqual({ phase: "front" });
  await ungated.until(ids.readings.assess, "terminal");
  ungated.releaseFront();
  await ungated.until(ids.readings["lane-review"], "terminal");
  const keyOf = async (
    gated: Awaited<ReturnType<typeof gatedWorld>>,
    task: TaskId,
  ) =>
    ((await gated.stateOf(task))!.outcome as { result: ReadingTaskResult })
      .result.evidence!;
  const plainKey = await keyOf(ungated, ids.readings.assess);
  await ungated.close();
  expect(none.n).toBe(0);
  // The decision as a reading made it before the gate: the same bytes as one made directly, with no
  // gate in its key or its stored form.
  const direct = world.runOf();
  const directKey = await groupEvidence(direct.ctx, direct.run, world.input);
  const plainEvidence = await readEvidence(plain.ctx, plain.run, plainKey);
  const directEvidence = await readEvidence(direct.ctx, direct.run, directKey!);
  expect(JSON.stringify(plainEvidence)).toBe(JSON.stringify(directEvidence));
  expect("gate" in plainEvidence).toBe(false);
  expect(plainKey).toBe(
    Computations.computationKey(
      evidenceSpec({
        cycleId: plain.ctx.cycleId,
        runKey: plain.ctx.runKey,
        ...world.input,
      }),
    ).key,
  );

  // A gate that ended before the readings looked (the head was stored first): no wait.
  const early = world.runOf();
  const ran = { n: 0 };
  const ended = await gatedWorld(world, early);
  const opened = await ended.open(early, counting(ran));
  ended.endGate({
    status: "completed",
    result: { status: "stored", head: headSide(world, "stored", 3) },
  });
  ended.releaseFront();
  const made = await ended.create(opened.reading, { standIn: true });
  await ended.until(made.gate, "terminal");
  await ended.until(made.readings.assess, "terminal");
  await ended.until(made.readings["lane-review"], "terminal");
  const earlyKey = await keyOf(ended, made.readings.assess);
  await ended.close();
  expect(ran.n).toBe(0);
  const earlyEvidence = await readEvidence(early.ctx, early.run, earlyKey);
  expect(earlyEvidence.gate).toEqual({ status: "stored", wallMs: 3 });
  expect(earlyEvidence.outcome).toBe("read");
  // The same rows as the decision made with no gate: only the gate's end is added.
  const { gate: _gate, ...rest } = earlyEvidence;
  expect(rest).toEqual(directEvidence);
}, 120_000);

// Reason (round 22): in every real review the readings plan's `prepare` listed reading tasks whose
// input carried the head gate, a key its own schema did not take, so the plan ended failed and no
// reading ran, while the tests above created readings by hand. This drives the real readings plan
// task and the real readings port (`reviewStages`, as the review's runtime builds them), created as
// the review's precompute commit creates them beside graph's head gate, cold and with the head's
// relations stored first: the plan names its readings, each carries the gate's ID, and they decide
// once the gate ends.
test("the review's real readings plan, given graph's head gate as the review gives it, creates readings that carry the gate and decide once it ends, cold and with the head stored first", async () => {
  for (const first of ["cold", "stored-first"] as const) {
    const world = await reviewWorld();
    if (first === "stored-first")
      await world.relationsOf(world.commits.headOid);
    // The run's frozen configuration holds the readings block: the port and the gate are given.
    const at = world.runOf(undefined, true);
    expect(at.ctx.config.readings).toBeDefined();
    const gated = await gatedWorld(world, at);
    const { harness, stages, startReview } = await gated.openStages(at);
    expect(stages.headGate).toBeDefined();
    const ids = await startReview();
    const planEnd = await harness.waitForTask(ids.plan, context);
    expect([first, planEnd.state.outcome.status]).toEqual([first, "completed"]);
    const planned = (planEnd.state.outcome as { result: ReadingsPlanResult })
      .result;
    // The plan names its readings: an Assess and a Lane review per group, and (round 27) each
    // group's briefing and digest task, which carry no gate and are not readings of the evidence.
    expect([first, planned.status]).toEqual([first, "ok"]);
    const readings = planned.readings.filter(
      (reading) =>
        !reading.name.startsWith("brief.") &&
        !reading.name.startsWith("digest."),
    );
    // Its briefing and its digest task, per group.
    expect(planned.readings.length - readings.length).toBe(readings.length);
    expect(readings.length).toBeGreaterThanOrEqual(2);
    expect(readings.length % 2).toBe(0);
    // No prepare failed, and each reading's stored input carries the gate's ID.
    expect(
      world.rows
        .filter((row) => row.type.startsWith("readings.prepare"))
        .map((row) => [row.type, row["status"]]),
    ).toEqual([["readings.prepare", "ok"]]);
    for (const { task } of readings) {
      const stored = await gated.stateOf(task);
      expect(stored).toBeDefined();
      const record = await harness.getTask(task, context);
      expect((record!.input as ReadingTaskInput).relations).toBe(
        Number(ids.gate),
      );
      expect((record!.input as ReadingTaskInput).front).toBe(Number(ids.front));
    }
    gated.releaseFront();
    // Each reading ends, having decided once the gate ended, from one decision per group.
    const ended = await Promise.all(
      readings.map(async ({ task }) => {
        const state = await gated.until(task, "terminal");
        return (state!.outcome as { result?: ReadingTaskResult }).result;
      }),
    );
    const gateState = await gated.stateOf(ids.gate);
    expect(gateState?.status).toBe("terminal");
    const gateEnd = headGateEndOf(
      gateState!.outcome as TaskOutcome<RelationsResult>,
    );
    expect([first, gateEnd.status]).toEqual([first, "stored"]);
    const keys = new Set(ended.map((result) => result?.evidence));
    expect(keys.has(undefined)).toBe(false);
    expect(keys.size).toBe(readings.length / 2);
    for (const key of keys) {
      const evidence = await readEvidence(at.ctx, at.run, key!);
      expect(evidence.gate).toEqual(gateEnd);
      // The head's relations, cold or stored first, are stored when the group decides.
      expect([first, evidence.outcome]).toEqual([first, "read"]);
    }
    await gated.close();
  }
}, 180_000);

// Reason: a follow-on run of a chain shows the decision its first run stored (keyed by the cycle and
// run key), so waiting up to the bound on its own gate would gain nothing. Its readings look the
// decision up, read only, find it stored, skip the wait and decide once with it, while the gate
// still runs.
test("a follow-on whose group decision is stored waits for nothing on its gate and decides once with the stored evidence", async () => {
  const world = await reviewWorld();
  // The chain's first run decided while nothing was stored for the head.
  const first = world.runOf();
  const firstKey = (await groupEvidence(first.ctx, first.run, world.input))!;
  expect(await evidenceStored(first.ctx, first.run, world.input)).toBe(true);
  // The head is stored by the follow-on; a new review would see it, the chain does not.
  await world.relationsOf(world.commits.headOid);
  const before = decisions(world);
  const followOn = world.runOf(undefined, false, first.ctx.cycleId);
  expect(followOn.ctx.runId).not.toBe(first.ctx.runId);
  const gated = await gatedWorld(world, followOn);
  const waited = { n: 0 };
  const { reading } = await gated.open(followOn, (task) => {
    const relations = task.definition.phases.relations;
    return {
      ...task,
      definition: {
        ...task.definition,
        phases: {
          ...task.definition.phases,
          relations: async (t, runtime, c) => {
            waited.n++;
            return relations(t, runtime, c);
          },
        },
      },
    };
  });
  // The stand-in gate never ends here: a reading that waited on it would never end.
  const ids = await gated.create(reading, { standIn: true });
  await gated.until(ids.readings.assess, "terminal");
  gated.releaseFront();
  await gated.until(ids.readings["lane-review"], "terminal");
  expect((await gated.stateOf(ids.gate))?.status).toBe("running");
  const keys = await Promise.all(
    (["assess", "lane-review"] as const).map(
      async (kind) =>
        (
          (await gated.stateOf(ids.readings[kind]))!.outcome as {
            result: ReadingTaskResult;
          }
        ).result.evidence,
    ),
  );
  await gated.close();
  expect(waited.n).toBe(0);
  expect(keys).toEqual([firstKey, firstKey]);
  expect(decisions(world)).toBe(before);
  expect(gated.shown.map((s) => [s.kind, s.evidence])).toEqual([
    ["assess", firstKey],
    ["lane-review", firstKey],
  ]);
  const evidence = await readEvidence(followOn.ctx, followOn.run, firstKey);
  expect(evidence.outcome).toBe("not-stored");
  expect("gate" in evidence).toBe(false);
  // A new review (another cycle) has no stored decision: its readings would wait.
  const other = world.runOf();
  expect(await evidenceStored(other.ctx, other.run, world.input)).toBe(false);
}, 120_000);

// Reason: record 0016 and the durable wait. A worker stopped while the group waits leaves it waiting
// on the same gate; the worker that opens the store again wakes it at the gate's end, and a phase
// replayed after its decision was stored (the worker stopped before its commit) reads that decision
// stored: the group decides once and its step starts once.
test("a worker stopped while the group waits resumes it waiting on the same gate; a replayed wake decides nothing twice and starts its step once", async () => {
  const world = await reviewWorld();
  const at = world.runOf();
  const gated = await gatedWorld(world, at);
  const first = await gated.open(at);
  const ids = await gated.create(first.reading, { standIn: true });
  await gated.until(ids.readings.assess, "waiting");
  await gated.close();

  // The second worker (a new process: a new context of the same run). The Assess task is still
  // parked on the gate. Its wake decides and stores the group's decision, then the worker stops
  // before the phase commits: the decision is stored, the phase is not.
  const second = world.runOf(at.ctx.runId);
  let decidedKey: string | undefined;
  const decided = deferred<void>();
  await gated.open(second, (task) => ({
    ...task,
    definition: {
      ...task.definition,
      phases: {
        ...task.definition.phases,
        relations: async (t, runtime, c) => {
          const outcome = (await runtime.getTask(
            childId<RelationsResult>(t.input.relations!),
            c,
          ))!.state.outcome!;
          decidedKey = await groupEvidence(second.ctx, second.run, {
            ...world.input,
            gate: headGateEndOf(outcome as TaskOutcome<RelationsResult>),
          });
          decided.resolve();
          await untilAborted(runtime.signal);
        },
      },
    },
  }));
  const parked = await gated.stateOf(ids.readings.assess);
  expect(parked?.status === "waiting" && parked.on).toEqual([ids.gate]);
  const before = decisions(world);
  gated.endGate({
    status: "completed",
    result: { status: "cutoff", head: headSide(world, "cutoff", 1_500) },
  });
  await decided.promise;
  expect(decisions(world)).toBe(before + 1);
  await gated.close();

  // The third worker replays the wake: it finds the stored decision, starts the read once.
  const third = world.runOf(at.ctx.runId);
  await gated.open(third);
  gated.releaseFront();
  await gated.until(ids.readings.assess, "terminal");
  await gated.until(ids.readings["lane-review"], "terminal");
  const results = await Promise.all(
    (["assess", "lane-review"] as const).map(
      async (kind) =>
        (
          (await gated.stateOf(ids.readings[kind]))!.outcome as {
            result: ReadingTaskResult;
          }
        ).result,
    ),
  );
  await gated.close();
  expect(decisions(world)).toBe(before + 1);
  expect(results.map((r) => r.evidence)).toEqual([decidedKey, decidedKey]);
  expect(gated.shown.map((s) => [s.kind, s.part])).toEqual([
    ["assess", "read"],
    ["lane-review", "read"],
  ]);
  const evidence = await readEvidence(third.ctx, third.run, decidedKey!);
  expect(evidence.gate).toEqual({ status: "cutoff", wallMs: 1_500 });
  expect(relationsGapCause(evidence, "not-read")).toBe("computing");
}, 120_000);

// Reason: the point of the round, on the real engine and a real Git repository. Nothing is stored
// for the head when the review starts: graph's own head gate computes the head's relations while the
// group waits on it, and at its end the group is shown its caller rows, and the lift fires on the
// trusted call from a file that is not a test.
test.skipIf(realEngine.skip)(
  "on the real engine, a group waiting on the head gate while the gate computes the head's relations is shown its caller rows, and the trusted not-test call lifts its gap",
  async () => {
    realEngine.require();
    const world = await reviewWorld({
      texts: { b: REAL_B, test: REAL_TESTS.named },
      real: true,
    });
    // Nothing is stored for the head before the review.
    const peek = world.runOf();
    const early = await readEvidence(
      peek.ctx,
      peek.run,
      (await groupEvidence(peek.ctx, peek.run, world.input))!,
    );
    expect(early.outcome).toBe("not-stored");
    const at = world.runOf();
    const gated = await gatedWorld(world, at);
    const { reading } = await gated.open(at);
    const ids = await gated.create(reading);
    gated.releaseFront();
    await gated.until(ids.readings.assess, "terminal");
    await gated.until(ids.readings["lane-review"], "terminal");
    const gateEnd = (await gated.stateOf(ids.gate))!
      .outcome as TaskOutcome<RelationsResult>;
    const result = (
      (await gated.stateOf(ids.readings.assess))!.outcome as {
        result: ReadingTaskResult;
      }
    ).result;
    await gated.close();
    // The gate computed the head (not stored first) and ended stored.
    expect(gateEnd).toMatchObject({
      status: "completed",
      result: { status: "stored", head: { outcome: "computed" } },
    });
    const evidence = await readEvidence(at.ctx, at.run, result.evidence!);
    expect(evidence.outcome).toBe("read");
    expect(evidence.gate?.status).toBe("stored");
    const section = evidence.sections.find((s) => s.key === world.section)!;
    expect(
      section.rows.map((r) => [r.kind, r.path, r.shows, r.confirmed]),
    ).toEqual([
      ["caller", "b.ts", "call", true],
      ["test", "tests/a.test.ts", "call", true],
    ]);
    expect(section.rows.some((r) => r.undecided !== undefined)).toBe(false);
    expect(section.relations).toBe("shown");
    expect(decidedX(world.plan, world.hunks, evidence, world.section)).toBe(
      false,
    );
    expect(laneX(world.plan, world.hunks, evidence, world.section)).toBe(
      "static-automation",
    );
  },
  180_000,
);
