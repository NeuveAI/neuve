/**
 * One small repository read by the real Graph engine, with every expected relation written down as
 * data (NEU-148, graph lane round 11). Every lane that consumes the relations tests at least once on
 * the real engine; this is the shared repository for it, so no lane builds its own.
 *
 * A consumer:
 *
 *   const fixture = useRelationsFixture();
 *   test.skipIf(relationsGraph.skip)("…", async () => {
 *     relationsGraph.require();
 *     const expected = relation("summary-total");
 *     const row = await fixture.row(expected, "head");
 *     expect(row?.matched).toBe(expected.engine.matched);
 *     expectCallLine(row, expected, "head");
 *   }, RELATIONS_FIXTURE_TIMEOUT_MS);
 *
 * Lines are never written as numbers: each one is found from the source text by a marker comment
 * on that line (`call:<id>` on a call, `def:<id>` on a declaration, `change:<key>` on a changed
 * line), so an edit to the sources cannot leave a line behind.
 *
 * What the engine gives is recorded as it is, with a note where it is a known limit (brief point 5):
 * `engine` on each expectation is the real answer at the pinned engine, not the one wished for.
 */
import { afterAll, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../../scripts/graph-test-prerequisite.ts";
import { readDeclarations } from "../../src/declarations.ts";
import { lsTree } from "../../src/git-objects.ts";
import {
  captureOutlineSource,
  type OutlineSource,
} from "../../src/graph-outline.ts";
import {
  declaredTestFiles,
  isRelationsGap,
  relationSlices,
  relationsGraphDirectory,
  relationsReadsInFlight,
  relationsRound,
  type CallFamily,
  type MatchClass,
  type RelationSlice,
  type RelationsIndex,
  type RelationsRound,
  type SliceCaller,
  type SliceSubject,
  type SliceSymbol,
  type SliceTestFiles,
} from "../../src/relations.ts";

/** The engine's identity, as the harness captures it (`captureOutlineSource`). */
export const source = captureOutlineSource();

/** `capabilities --json` of the engine, or null when it cannot be read. */
const declaredCapabilities = (() => {
  if (!("sha256" in source.key)) return null;
  const result = Bun.spawnSync([source.executable, "capabilities", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
})();

const declaresFeature = (feature: string) => {
  const features = declaredCapabilities?.optional_local_only_features;
  return (
    typeof features === "object" &&
    features !== null &&
    (features as Record<string, unknown>)[feature] === true
  );
};

/**
 * The engine prerequisite, as every real-engine relations test has it: a missing or stale engine
 * skips in a package run and fails under `NEUVE_MODE=check`, never silently. The expectations
 * assert call lines, so an engine from before `call_site_lines` is stale here.
 */
export const relationsGraph = graphTestPrerequisite({
  available:
    declaresFeature("exact_commit_bulk_streams") &&
    declaresFeature("call_site_lines"),
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must declare exact_commit_bulk_streams and call_site_lines. Run `bun run build:graph` from the workspace root.",
});

/** A test's timeout when it reads the fixture's relations (one cold read of both sides). */
export const RELATIONS_FIXTURE_TIMEOUT_MS = 120_000;

/**
 * The capability that says a call relation's line is the call's own line (`call_site_lines`), with
 * its languages in `feature_languages`. The index takes it from the read that built it
 * (`coverage.callSiteLineLanguages`); this reads the same key from the engine directly, so a test
 * can check the two agree and assert lines before any read. An engine without the key, or a
 * language it does not list, gives no call line.
 */
export const CALL_SITE_LINES = "call_site_lines";
const languagesDeclared = (
  capabilities: Record<string, unknown> | null,
): readonly string[] => {
  const features = capabilities?.optional_local_only_features;
  if (
    typeof features !== "object" ||
    features === null ||
    (features as Record<string, unknown>)[CALL_SITE_LINES] !== true
  )
    return [];
  const languages = capabilities?.feature_languages;
  if (typeof languages !== "object" || languages === null) return [];
  const listed = (languages as Record<string, unknown>)[CALL_SITE_LINES];
  return Array.isArray(listed)
    ? listed.filter((entry): entry is string => typeof entry === "string")
    : [];
};
export const callSiteLineLanguages = (): readonly string[] =>
  languagesDeclared(declaredCapabilities);

/** `capabilities --json` of another engine, or null. */
const capabilitiesOf = (executable: string) => {
  const result = Bun.spawnSync([executable, "capabilities", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout.toString());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * An engine from before call lines (Graph `d592b44`, which declares exact-commit streams and no
 * `call_site_lines`), for the test that reads this fixture with it: `NEUVE_GRAPH_ENGINE_WITHOUT_CALL_LINES`,
 * else this worktree's own engine where it is built before call lines. Where there is none, that
 * test skips in every mode: it needs a second engine, not a capability of the one under test (as
 * `section-tokens-real.test.ts` does for an engine without tokens).
 */
export const OLDER_RELATIONS_ENGINE = (() => {
  const executable =
    process.env.NEUVE_GRAPH_ENGINE_WITHOUT_CALL_LINES ??
    join(import.meta.dir, "../../../../apps/neuve-graph/entire-graph");
  if (!existsSync(executable)) return null;
  const capabilities = capabilitiesOf(executable);
  const features = capabilities?.optional_local_only_features as
    Record<string, unknown> | undefined;
  if (
    features?.exact_commit_bulk_streams !== true ||
    features[CALL_SITE_LINES] !== undefined
  )
    return null;
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = executable;
  try {
    return captureOutlineSource();
  } finally {
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
  }
})();

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/** The files at the base commit. */
const BASE_FILES: Readonly<Record<string, string>> = {
  "README.md": "A fixture for Graph relations.\n",
  "packages/direct/package.json": lines(
    '{"name":"direct","private":true,"scripts":{"test":"bun test ./tests"}}',
  ),
  "packages/direct/src/math.ts": lines(
    "export function total(xs: number[]): number { // def:total",
    "  return xs.reduce((sum, x) => sum + x, 0); // change:total",
    "}",
    "export function double(n: number): number { // def:double",
    "  return n * 2; // change:double",
    "}",
    "export function unused(): number { // def:unused",
    "  return 0; // change:unused",
    "}",
    "export function fact(n: number): number { // def:fact",
    "  if (n <= 1) return 1; // change:fact",
    "  return n * fact(n - 1); // call:fact-fact",
    "}",
  ),
  "packages/direct/src/counter.ts": lines(
    "export class Counter { // def:Counter",
    '  label = "a"; // def:Counter.label change:label',
    "  constructor(private count: number) {}",
    "  reset(): void { // def:Counter.reset change:bump",
    "    this.count = 0; // change:bump",
    "  } // change:bump",
    "  bump(): number { // def:Counter.bump change:bump",
    "    this.count += 1; // change:bump",
    "    return this.count;",
    "  }",
    "  twice(): number { // def:Counter.twice",
    "    this.bump(); // call:twice-bump",
    "    return this.bump(); // change:twice",
    "  }",
    "  peek(other: any): number { // def:Counter.peek",
    "    return other.bump(); // call:peek-bump",
    "  }",
    "  get size(): number { // def:Counter.size-get",
    "    return this.count;",
    "  }",
    "  set size(value: number) { // def:Counter.size-set",
    "    this.count = value; // change:size",
    "  }",
    "}",
  ),
  "packages/direct/src/report.ts": lines(
    'import { total, double } from "./math";',
    'import { Counter } from "./counter";',
    'import { old } from "./legacy"; // change:drop-old-caller',
    "export function summary(xs: number[]): number { // def:summary",
    "  const doubled = xs.map(double); // pass:summary-double",
    "  return total(doubled); // call:summary-total",
    "}",
    "export function tally(counter: Counter): number { // def:tally",
    "  return counter.bump(); // call:tally-bump",
    "}",
    "export function make(): Counter { // def:make",
    "  return new Counter(0); // call:make-counter",
    "}",
    "export function useOld(): number { // def:useOld change:drop-old-caller",
    "  return old(); // call:useOld-old change:drop-old-caller",
    "} // change:drop-old-caller",
  ),
  "packages/direct/src/legacy.ts": lines(
    "export function old(): number { // def:old change:remove-old",
    "  return 1; // change:remove-old",
    "} // change:remove-old",
    "export function keepA(): number { // def:keepA",
    "  return 2;",
    "}",
    "export function ghost(): number { // def:ghost change:remove-ghost",
    "  return 3; // change:remove-ghost",
    "} // change:remove-ghost",
    "export function keepB(): number { // def:keepB",
    "  return 4;",
    "}",
    "export function lonely(): number { // def:lonely change:remove-lonely",
    "  return 5; // change:remove-lonely",
    "} // change:remove-lonely",
    "export function keepC(): number { // def:keepC",
    "  return 6;",
    "}",
    "export function before(): string { // def:before change:rename",
    '  return "b";',
    "}",
  ),
  "packages/direct/src/keep.ts": lines(
    'import { old, keepA } from "./legacy";',
    "export function stay(): number { // def:stay",
    "  return old() + 1; // call:stay-old",
    "}",
    "export function relay(list: Array<() => number>): number { // def:relay",
    "  let n = keepA();",
    "  for (const ghost of list) n += ghost(); // call:relay-ghost",
    "  return n;",
    "}",
  ),
  "packages/direct/src/local.ts": lines(
    "export function sums(list: Array<() => number>): number { // def:sums",
    "  let n = 0;",
    "  for (const total of list) n += total(); // call:sums-total",
    "  return n;",
    "}",
  ),
  "packages/direct/src/late.ts": lines(
    "export async function later(): Promise<number> { // def:later",
    '  const { total } = await import("./math");',
    "  return total([1]); // call:later-total",
    "}",
  ),
  "packages/direct/tests/math.test.ts": lines(
    'import { expect, test } from "bun:test";',
    'import { fact, total } from "../src/math";',
    "function check(xs: number[]): number { // def:check",
    "  return total(xs); // call:check-total",
    "}",
    'test("total", () => {',
    "  expect(total([1, 2])).toBe(3); // call:direct-test-total",
    "  expect(check([2])).toBe(2);",
    "});",
    'test("fact", () => {',
    "  expect(fact(3)).toBe(6); // call:direct-test-fact",
    "});",
  ),
  "packages/wrapped/package.json": lines(
    '{"name":"wrapped","private":true,"scripts":{"test":"node scripts/run-tests.js ./tests"}}',
  ),
  "packages/wrapped/scripts/run-tests.js": lines(
    'const { spawnSync } = require("node:child_process");',
    'const run = spawnSync("bun", ["test", ...process.argv.slice(2)], { stdio: "inherit" });',
    "process.exitCode = run.status ?? 1;",
  ),
  "packages/wrapped/tests/wrapped.test.ts": lines(
    'import { expect, test } from "bun:test";',
    'import { total } from "../../direct/src/math";',
    'test("wrapped total", () => {',
    "  expect(total([2])).toBe(2); // call:wrapped-test-total",
    "});",
  ),
  "py/fx/__init__.py": "",
  "py/fx/util.py": lines(
    "def helper(x):  # def:helper",
    "    return x + 1  # change:helper",
  ),
  "py/fx/main.py": lines(
    "from .util import helper",
    "",
    "",
    "class Runner:  # def:Runner",
    "    def step(self):  # def:Runner.step",
    "        return 1  # change:step",
    "",
    "    def go(self):  # def:Runner.go",
    "        return self.step()  # call:go-step",
    "",
    "",
    "def run():  # def:run",
    "    value = helper(1)  # call:run-helper",
    "    return value  # change:run",
    "",
    "",
    'if __name__ == "__main__":',
    "    run()  # call:main-run",
  ),
  "go.mod": lines("module example.com/fx", "", "go 1.22"),
  "go/calc/calc.go": lines(
    "package calc",
    "",
    "func Add(a, b int) int { // def:Add",
    "\treturn a + b // change:Add",
    "}",
    "",
    "func Double(a int) int { // def:Double",
    "\treturn Add(a, a) // call:double-add",
    "}",
    "",
    "type Acc struct { // def:Acc",
    "\tn int",
    "}",
    "",
    "func (a *Acc) Push(v int) { // def:Acc.Push",
    "\ta.n += v // change:Push",
    "}",
    "",
    "func (a *Acc) PushTwice(v int) { // def:Acc.PushTwice",
    "\ta.Push(v) // call:pushtwice-push",
    "\ta.Push(v)",
    "}",
  ),
  "go/cmd/run/main.go": lines(
    "package main",
    "",
    'import "example.com/fx/go/calc"',
    "",
    "func main() { // def:main",
    "\t_ = calc.Add(1, 2) // call:main-add",
    "\tacc := &calc.Acc{}",
    "\tacc.Push(3) // call:main-push",
    "}",
  ),
};

/** The head commit: every changed file whole, on the review branch. */
const HEAD_CHANGES: Readonly<Record<string, string>> = {
  "packages/direct/src/math.ts": lines(
    "export function total(xs: number[]): number { // def:total",
    "  return xs.reduce((sum, x) => x + sum, 0); // change:total",
    "}",
    "export function double(n: number): number { // def:double",
    "  return n + n; // change:double",
    "}",
    "export function unused(): number { // def:unused",
    "  return -1; // change:unused",
    "}",
    "export function fact(n: number): number { // def:fact",
    "  if (n < 2) return 1; // change:fact",
    "  return n * fact(n - 1); // call:fact-fact",
    "}",
    "export function fresh(): number { // def:fresh change:add-fresh",
    "  return 7; // change:add-fresh",
    "} // change:add-fresh",
  ),
  "packages/direct/src/counter.ts": lines(
    "export class Counter { // def:Counter",
    '  label = "b"; // def:Counter.label change:label',
    "  constructor(private count: number) {}",
    "  bump(step = 1): number { // def:Counter.bump change:bump",
    "    this.count += step; // change:bump",
    "    return this.count;",
    "  }",
    "  twice(): number { // def:Counter.twice",
    "    this.bump(); // call:twice-bump",
    "    return this.bump() + 0; // change:twice",
    "  }",
    "  peek(other: any): number { // def:Counter.peek",
    "    return other.bump(); // call:peek-bump",
    "  }",
    "  get size(): number { // def:Counter.size-get",
    "    return this.count;",
    "  }",
    "  set size(value: number) { // def:Counter.size-set",
    "    this.count = Math.max(0, value); // change:size",
    "  }",
    "}",
  ),
  "packages/direct/src/report.ts": lines(
    'import { total, double } from "./math";',
    'import { Counter } from "./counter";',
    'import { fresh } from "./math"; // change:add-fresh-call',
    "export function summary(xs: number[]): number { // def:summary",
    "  const doubled = xs.map(double); // pass:summary-double",
    "  return total(doubled); // call:summary-total",
    "}",
    "export function tally(counter: Counter): number { // def:tally",
    "  return counter.bump(); // call:tally-bump",
    "}",
    "export function make(): Counter { // def:make",
    "  return new Counter(0); // call:make-counter",
    "}",
    "export function useFresh(): number { // def:useFresh change:add-fresh-call",
    "  return fresh(); // call:useFresh-fresh change:add-fresh-call",
    "} // change:add-fresh-call",
  ),
  "packages/direct/src/legacy.ts": lines(
    "export function keepA(): number { // def:keepA",
    "  return 2;",
    "}",
    "export function keepB(): number { // def:keepB",
    "  return 4;",
    "}",
    "export function keepC(): number { // def:keepC",
    "  return 6;",
    "}",
    "export function after(): string { // def:after change:rename",
    '  return "b";',
    "}",
  ),
  "py/fx/util.py": lines(
    "def helper(x):  # def:helper",
    "    return x + 2  # change:helper",
  ),
  "py/fx/main.py": lines(
    "from .util import helper",
    "",
    "",
    "class Runner:  # def:Runner",
    "    def step(self):  # def:Runner.step",
    "        return 2  # change:step",
    "",
    "    def go(self):  # def:Runner.go",
    "        return self.step()  # call:go-step",
    "",
    "",
    "def run():  # def:run",
    "    value = helper(1)  # call:run-helper",
    "    return value + 0  # change:run",
    "",
    "",
    'if __name__ == "__main__":',
    "    run()  # call:main-run",
  ),
  "go/calc/calc.go": lines(
    "package calc",
    "",
    "func Add(a, b int) int { // def:Add",
    "\treturn b + a // change:Add",
    "}",
    "",
    "func Double(a int) int { // def:Double",
    "\treturn Add(a, a) // call:double-add",
    "}",
    "",
    "type Acc struct { // def:Acc",
    "\tn int",
    "}",
    "",
    "func (a *Acc) Push(v int) { // def:Acc.Push",
    "\ta.n = a.n + v // change:Push",
    "}",
    "",
    "func (a *Acc) PushTwice(v int) { // def:Acc.PushTwice",
    "\ta.Push(v) // call:pushtwice-push",
    "\ta.Push(v)",
    "}",
  ),
};

/** The commit the base branch gets after the review branch left it: not in the review. */
const BASE_BRANCH_LATER: Readonly<Record<string, string>> = {
  "README.md": "A fixture for Graph relations, on the base branch's tip.\n",
};

export type Side = "base" | "head";

/** Every file's text at each side, as committed. */
export const FIXTURE_FILES: Readonly<
  Record<Side, Readonly<Record<string, string>>>
> = {
  base: BASE_FILES,
  head: { ...BASE_FILES, ...HEAD_CHANGES },
};

/** The marker words on a line: `// a:b c:d` or `# a:b`, at the line's end. */
const markersOf = (line: string): readonly string[] => {
  const found = /(?:\/\/|#)\s*((?:[a-z-]+:[\w.-]+\s*)+)$/.exec(line);
  return found?.[1]?.trim().split(/\s+/) ?? [];
};

/** The 1-based lines of `path` at `side` that carry `marker` (`call:summary-total`). */
export const markedLines = (
  side: Side,
  path: string,
  marker: string,
): readonly number[] => {
  const text = FIXTURE_FILES[side][path];
  if (text === undefined) return [];
  return text
    .split("\n")
    .flatMap((line, at) => (markersOf(line).includes(marker) ? [at + 1] : []));
};

/** The one line of `path` at `side` with `marker`; throws unless there is exactly one. */
export const markedLine = (side: Side, path: string, marker: string) => {
  const found = markedLines(side, path, marker);
  if (found.length !== 1 || found[0] === undefined)
    throw new Error(
      `${path} at ${side} has ${found.length} lines marked ${marker}`,
    );
  return found[0];
};

/** Which file declares each symbol a marker names (`def:<id>`). */
const declaredIn = (side: Side, id: string) => {
  const paths = Object.keys(FIXTURE_FILES[side]).filter(
    (path) => markedLines(side, path, `def:${id}`).length > 0,
  );
  if (paths.length !== 1 || paths[0] === undefined)
    throw new Error(`def:${id} is declared in ${paths.length} files`);
  return paths[0];
};

/** The 1-based line a symbol is declared on (its `def:` marker). */
export const declarationLine = (side: Side, id: string) =>
  markedLine(side, declaredIn(side, id), `def:${id}`);

/**
 * The changed ranges, one subject per change key, in the sections' shape: `key` and ranges per side
 * (`old` lines of the base, `new` lines of the head), each range a run of consecutive lines marked
 * `change:<key>`. The fixture's own test checks that together they are exactly the diff's lines.
 */
export const SUBJECT_KEYS = [
  "total",
  "double",
  "unused",
  "fact",
  "add-fresh",
  "label",
  "bump",
  "twice",
  "size",
  "drop-old-caller",
  "add-fresh-call",
  "remove-old",
  "remove-ghost",
  "remove-lonely",
  "rename",
  "helper",
  "step",
  "run",
  "Add",
  "Push",
] as const;
export type SubjectKey = (typeof SUBJECT_KEYS)[number];

const runsOf = (numbers: readonly number[]) => {
  const runs: Array<{ startLine: number; lineCount: number }> = [];
  for (const line of numbers) {
    const last = runs.at(-1);
    if (last !== undefined && last.startLine + last.lineCount === line)
      last.lineCount++;
    else runs.push({ startLine: line, lineCount: 1 });
  }
  return runs;
};

export const subjects: readonly SliceSubject[] = SUBJECT_KEYS.map((key) => ({
  key,
  ranges: (
    [
      ["old", "base"],
      ["new", "head"],
    ] as const
  ).flatMap(([range, side]) =>
    Object.keys(FIXTURE_FILES[side])
      .sort()
      .flatMap((path) =>
        runsOf(markedLines(side, path, `change:${key}`)).map((run) => ({
          side: range,
          path,
          ...run,
        })),
      ),
  ),
}));

export type ExpectedCaller =
  | Readonly<{ kind: "symbol"; name: string; def: string }>
  | Readonly<{ kind: "file" }>;

/** What the pinned engine gives for an expected call, read on this fixture. */
export type EngineAnswer =
  | Readonly<{ edge: "kept"; matched: MatchClass }>
  /** No edge is kept into the target from this caller (a blind spot, or a match not kept). */
  | Readonly<{ edge: "none" }>;

export type ExpectedRelation = Readonly<{
  /** The call's marker id: `call:<id>` (or `pass:<id>` for a function passed by name). */
  id: string;
  language: "TypeScript" | "Python" | "Go";
  /** The sides whose source holds the call. */
  sides: readonly Side[];
  caller: ExpectedCaller;
  callerPath: string;
  target: Readonly<{ path: string; name: string; def: string }>;
  family: CallFamily;
  /** The subject whose ranges touch the target, so its slice lists the target. */
  subject: SubjectKey;
  /** The caller's file is a test by the repository's declarations. */
  test: boolean;
  /** Is the matched thing really a call of the target (the truth, whatever the engine says)? */
  isCall: boolean;
  engine: EngineAnswer;
  /** A known limit or a surprise, in one line. */
  note?: string;
  /**
   * What the row's place shows where the engine declares call lines for the caller's language
   * (`SliceSite`): `call` where a call is written at `lines[side].call`, `reference` where the
   * caller hands the target over by name there and never calls it. Elsewhere every row shows
   * `caller`.
   */
  shows: "call" | "reference";
  /**
   * Per side: the line of the call as written (from its marker), and `siteToday`, the line the
   * index gives where no call line is declared (an engine before `call_site_lines`, or a language it
   * does not list): the calling function's first line, or null for a file-level caller. The name
   * is kept for the consumers that read it.
   */
  lines: Readonly<
    Partial<Record<Side, Readonly<{ call: number; siteToday: number | null }>>>
  >;
}>;

type Draft = Omit<ExpectedRelation, "lines" | "shows"> &
  Readonly<{
    /**
     * What the index gives as the site without call lines when it is not the rule (the calling
     * function's first line, or none for a file-level caller): `call-line` where the engine already
     * gave the call's.
     */
    siteToday?: "call-line";
    /** `call` unless given. */
    shows?: "reference";
  }>;

const withLines = ({
  siteToday,
  shows,
  ...draft
}: Draft): ExpectedRelation => ({
  ...draft,
  shows: shows ?? "call",
  lines: Object.fromEntries(
    draft.sides.map((side) => {
      const call = markedLine(
        side,
        draft.callerPath,
        `${draft.id === "summary-double" ? "pass" : "call"}:${draft.id}`,
      );
      return [
        side,
        {
          call,
          siteToday:
            siteToday === "call-line"
              ? call
              : draft.caller.kind === "file"
                ? null
                : declarationLine(side, draft.caller.def),
        },
      ];
    }),
  ),
});

const DIRECT = "packages/direct";
const MATH = `${DIRECT}/src/math.ts`;
const COUNTER = `${DIRECT}/src/counter.ts`;
const LEGACY = `${DIRECT}/src/legacy.ts`;
const both = ["base", "head"] as const;

/** Every expected call, with the engine's real answer at the pinned engine. */
export const EXPECTED_RELATIONS: readonly ExpectedRelation[] = (
  [
    {
      id: "summary-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "summary", def: "summary" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "check-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "check", def: "check" },
      callerPath: `${DIRECT}/tests/math.test.ts`,
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: true,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "direct-test-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "file" },
      callerPath: `${DIRECT}/tests/math.test.ts`,
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: true,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      note: "a call inside a test(...) callback is attributed to the file",
    },
    {
      id: "wrapped-test-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "file" },
      callerPath: "packages/wrapped/tests/wrapped.test.ts",
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      note: "the wrapper package's test script does not run bun test, so its file is no declared test",
    },
    {
      id: "later-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "later", def: "later" },
      callerPath: `${DIRECT}/src/late.ts`,
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "name-only" },
      note: "a name bound by a dynamic import(): a real call the engine matches by name only",
    },
    {
      id: "sums-total",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "sums", def: "sums" },
      callerPath: `${DIRECT}/src/local.ts`,
      target: { path: MATH, name: "total", def: "total" },
      family: "CALLS",
      subject: "total",
      test: false,
      isCall: false,
      engine: { edge: "none" },
      note: "a loop variable named like the target in a file that does not import it: matched by name, not kept, counted as not used",
    },
    {
      id: "fact-fact",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "fact", def: "fact" },
      callerPath: MATH,
      target: { path: MATH, name: "fact", def: "fact" },
      family: "CALLS",
      subject: "fact",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      siteToday: "call-line",
      note: "a recursive call: the one case where an engine without call lines already gave the call's own line (still shown as `caller` there, since nothing declares it)",
    },
    {
      id: "direct-test-fact",
      language: "TypeScript",
      sides: both,
      caller: { kind: "file" },
      callerPath: `${DIRECT}/tests/math.test.ts`,
      target: { path: MATH, name: "fact", def: "fact" },
      family: "CALLS",
      subject: "fact",
      test: true,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "summary-double",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "summary", def: "summary" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: MATH, name: "double", def: "double" },
      family: "CALLS",
      subject: "double",
      test: false,
      isCall: false,
      engine: { edge: "kept", matched: "resolved" },
      shows: "reference",
      note: "passed by name to map, not called there: the engine records a resolved CALLS edge, and with call lines marks its line a reference",
    },
    {
      id: "tally-bump",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "tally", def: "tally" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: COUNTER, name: "bump", def: "Counter.bump" },
      family: "CALLS",
      subject: "bump",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "receiver-type" },
    },
    {
      id: "twice-bump",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "twice", def: "Counter.twice" },
      callerPath: COUNTER,
      target: { path: COUNTER, name: "bump", def: "Counter.bump" },
      family: "CALLS",
      subject: "bump",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "receiver-type" },
    },
    {
      id: "peek-bump",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "peek", def: "Counter.peek" },
      callerPath: COUNTER,
      target: { path: COUNTER, name: "bump", def: "Counter.bump" },
      family: "CALLS",
      subject: "bump",
      test: false,
      isCall: false,
      engine: { edge: "none" },
      note: "a call on an untyped receiver, matched by name only to a method of the caller's own file: not kept (recipe v4), counted as not used",
    },
    {
      id: "make-counter",
      language: "TypeScript",
      sides: both,
      caller: { kind: "symbol", name: "make", def: "make" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: COUNTER, name: "Counter", def: "Counter" },
      family: "CONSTRUCTS",
      subject: "bump",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "useOld-old",
      language: "TypeScript",
      sides: ["base"],
      caller: { kind: "symbol", name: "useOld", def: "useOld" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: LEGACY, name: "old", def: "old" },
      family: "CALLS",
      subject: "remove-old",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "stay-old",
      language: "TypeScript",
      sides: ["base"],
      caller: { kind: "symbol", name: "stay", def: "stay" },
      callerPath: `${DIRECT}/src/keep.ts`,
      target: { path: LEGACY, name: "old", def: "old" },
      family: "CALLS",
      subject: "remove-old",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      note: "the caller stays and is unchanged; at the head its target is gone, so only the base has the edge",
    },
    {
      id: "relay-ghost",
      language: "TypeScript",
      sides: ["base"],
      caller: { kind: "symbol", name: "relay", def: "relay" },
      callerPath: `${DIRECT}/src/keep.ts`,
      target: { path: LEGACY, name: "ghost", def: "ghost" },
      family: "CALLS",
      subject: "remove-ghost",
      test: false,
      isCall: false,
      engine: { edge: "kept", matched: "name-only" },
      note: "a loop variable named like the target, in a file importing the target's: kept by name only, and wrong (a parameter of that name gets no match at all)",
    },
    {
      id: "useFresh-fresh",
      language: "TypeScript",
      sides: ["head"],
      caller: { kind: "symbol", name: "useFresh", def: "useFresh" },
      callerPath: `${DIRECT}/src/report.ts`,
      target: { path: MATH, name: "fresh", def: "fresh" },
      family: "CALLS",
      subject: "add-fresh",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "go-step",
      language: "Python",
      sides: both,
      caller: { kind: "symbol", name: "go", def: "Runner.go" },
      callerPath: "py/fx/main.py",
      target: { path: "py/fx/main.py", name: "step", def: "Runner.step" },
      family: "CALLS",
      subject: "step",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "receiver-type" },
      note: "a call on self is matched by the receiver's type",
    },
    {
      id: "run-helper",
      language: "Python",
      sides: both,
      caller: { kind: "symbol", name: "run", def: "run" },
      callerPath: "py/fx/main.py",
      target: { path: "py/fx/util.py", name: "helper", def: "helper" },
      family: "CALLS",
      subject: "helper",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "main-run",
      language: "Python",
      sides: both,
      caller: { kind: "file" },
      callerPath: "py/fx/main.py",
      target: { path: "py/fx/main.py", name: "run", def: "run" },
      family: "CALLS",
      subject: "run",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      note: 'a call under if __name__ == "__main__" is attributed to the file; with its call line only a range over that line marks it changed, with no line any range in the file does',
    },
    {
      id: "double-add",
      language: "Go",
      sides: both,
      caller: { kind: "symbol", name: "Double", def: "Double" },
      callerPath: "go/calc/calc.go",
      target: { path: "go/calc/calc.go", name: "Add", def: "Add" },
      family: "CALLS",
      subject: "Add",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
    },
    {
      id: "main-add",
      language: "Go",
      sides: both,
      caller: { kind: "symbol", name: "main", def: "main" },
      callerPath: "go/cmd/run/main.go",
      target: { path: "go/calc/calc.go", name: "Add", def: "Add" },
      family: "CALLS",
      subject: "Add",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "resolved" },
      note: "resolved through the module's go.mod at the repository root; a go.mod in a subfolder gave no edge at all",
    },
    {
      id: "main-push",
      language: "Go",
      sides: both,
      caller: { kind: "symbol", name: "main", def: "main" },
      callerPath: "go/cmd/run/main.go",
      target: { path: "go/calc/calc.go", name: "Push", def: "Acc.Push" },
      family: "CALLS",
      subject: "Push",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "name-only" },
      note: "a Go method called through a receiver from another package: a real call, matched by name only",
    },
    {
      id: "pushtwice-push",
      language: "Go",
      sides: both,
      caller: { kind: "symbol", name: "PushTwice", def: "Acc.PushTwice" },
      callerPath: "go/calc/calc.go",
      target: { path: "go/calc/calc.go", name: "Push", def: "Acc.Push" },
      family: "CALLS",
      subject: "Push",
      test: false,
      isCall: true,
      engine: { edge: "kept", matched: "receiver-type" },
      note: "a Go method called through a receiver in its own file: matched by the receiver's type",
    },
  ] satisfies readonly Draft[]
).map(withLines);

/** The expectation with this id; throws for an unknown one. */
export const relation = (id: string): ExpectedRelation => {
  const found = EXPECTED_RELATIONS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no expected relation ${id}`);
  return found;
};

/**
 * Changed symbols with no caller at all in the fixture, per side they exist on: their slice says
 * `evidence: "none"` (no evidence, never "no callers" as a claim about code).
 */
export const UNCALLED: ReadonlyArray<
  Readonly<{
    subject: SubjectKey;
    name: string;
    def: string;
    sides: readonly Side[];
  }>
> = [
  { subject: "unused", name: "unused", def: "unused", sides: both },
  { subject: "remove-lonely", name: "lonely", def: "lonely", sides: ["base"] },
  { subject: "rename", name: "before", def: "before", sides: ["base"] },
  { subject: "rename", name: "after", def: "after", sides: ["head"] },
  { subject: "bump", name: "reset", def: "Counter.reset", sides: ["base"] },
  { subject: "twice", name: "twice", def: "Counter.twice", sides: both },
  { subject: "label", name: "label", def: "Counter.label", sides: both },
  { subject: "size", name: "size", def: "Counter.size-set", sides: both },
];

/**
 * The three removals, each its own old-side-only hunk in a file that stays, each with no
 * counterpart at the head: the caller stays and is not name-only (`old`); the only match left is
 * name-only (`ghost`); no caller at all (`lonely`).
 */
export const DELETIONS = {
  callerStays: { subject: "remove-old", name: "old", def: "old" },
  onlyNameOnly: { subject: "remove-ghost", name: "ghost", def: "ghost" },
  noCaller: { subject: "remove-lonely", name: "lonely", def: "lonely" },
} as const;

/**
 * Per expected relation with a kept edge and per side: the site the index gives without call lines
 * (`siteToday`) beside the call's real line and what that place shows with call lines.
 */
export const callSitesToday = () =>
  EXPECTED_RELATIONS.flatMap((expected) =>
    expected.engine.edge === "none"
      ? []
      : expected.sides.map((side) => ({
          id: expected.id,
          side,
          language: expected.language,
          caller: expected.caller.kind,
          siteToday: expected.lines[side]?.siteToday ?? null,
          call: expected.lines[side]?.call ?? 0,
          shows: expected.shows,
        })),
  );

/**
 * The lines a declaration spans in the fixture's source at `side`, from its `def:` marker: to the
 * brace that closes it (TypeScript, Go), or to its last indented line (Python). Read from the text,
 * so the Git-only test can check a marked line against its caller without the engine.
 */
export const declarationSpan = (side: Side, id: string) => {
  const path = declaredIn(side, id);
  const start = declarationLine(side, id);
  const rows = (FIXTURE_FILES[side][path] ?? "").split("\n");
  if (path.endsWith(".py")) {
    const indent = (row: string) => row.length - row.trimStart().length;
    const own = indent(rows[start - 1] ?? "");
    let end = start;
    for (let at = start; at < rows.length; at++) {
      const row = rows[at] ?? "";
      if (row.trim() === "") continue;
      if (indent(row) <= own) break;
      end = at + 1;
    }
    return { path, start, end };
  }
  let depth = 0;
  let opened = false;
  for (let at = start - 1; at < rows.length; at++) {
    const code = (rows[at] ?? "").replace(/\/\/.*$/, "");
    for (const character of code)
      if (character === "{") {
        depth++;
        opened = true;
      } else if (character === "}") depth--;
    if (opened && depth === 0) return { path, start, end: at + 1 };
  }
  throw new Error(`def:${id} at ${side} never closes`);
};

/** Every `def:` id declared in `path` at `side`. */
export const declarationsIn = (side: Side, path: string) =>
  (FIXTURE_FILES[side][path] ?? "").split("\n").flatMap((line) =>
    markersOf(line)
      .filter((marker) => marker.startsWith("def:"))
      .map((marker) => marker.slice(4)),
  );

/**
 * The changed symbol a slice lists for a target at `side`: the one with the target's name whose
 * lines hold the target's declaration line (its `def:` marker), so two members of one name are
 * told apart.
 */
export const sliceSymbol = (
  slices: readonly RelationSlice[],
  subject: string,
  side: Side,
  target: Readonly<{ name: string; def: string }>,
): SliceSymbol | undefined => {
  const line = declarationLine(side, target.def);
  return slices
    .find((entry) => entry.key === subject)
    ?.[side].symbols.find(
      (entry) =>
        entry.symbol.name === target.name &&
        entry.symbol.startLine <= line &&
        line <= entry.symbol.endLine,
    );
};

/** The rows of a symbol's callers (shown), or none. */
export const shownCallers = (symbol: SliceSymbol | undefined) =>
  symbol?.callers.evidence === "supported" ? symbol.callers.shown : [];

/** The caller row an expectation names, at `side`, or undefined when the slice has none. */
export const findRow = (
  slices: readonly RelationSlice[],
  expected: ExpectedRelation,
  side: Side,
): SliceCaller | undefined =>
  shownCallers(
    sliceSymbol(slices, expected.subject, side, expected.target),
  ).find(
    (row) =>
      row.caller.path === expected.callerPath &&
      row.family === expected.family &&
      (expected.caller.kind === "file"
        ? row.caller.kind === "file"
        : row.caller.kind === "symbol" &&
          row.caller.symbol?.name === expected.caller.name),
  );

/**
 * Asserts a row's whole site (`SliceSite`) against the expectation. Where `languages` (by default
 * what the engine declares for `call_site_lines`; pass an index's `coverage.callSiteLineLanguages`
 * to judge by the read itself) lists the caller's language, the site is the call's own line and
 * shows what the expectation records (`call`, or `reference` for a function passed by name).
 * Otherwise it shows `caller`, and its line is what the index gives without call lines (the calling
 * function's first line, or none for a file-level caller). Returns whether a place was claimed.
 */
export const expectCallLine = (
  row: SliceCaller | undefined,
  expected: ExpectedRelation,
  side: Side,
  languages: readonly string[] = callSiteLineLanguages(),
): "call-line" | "no-call-line-claimed" => {
  expect(row).toBeDefined();
  const at = expected.lines[side];
  if (at === undefined)
    throw new Error(`${expected.id} has no call at the ${side}`);
  if (languages.includes(expected.language)) {
    expect([expected.id, side, row?.site]).toEqual([
      expected.id,
      side,
      { path: expected.callerPath, line: at.call, shows: expected.shows },
    ]);
    return "call-line";
  }
  expect([expected.id, side, row?.site]).toEqual([
    expected.id,
    side,
    { path: expected.callerPath, line: at.siteToday, shows: "caller" },
  ]);
  return "no-call-line-claimed";
};

/**
 * Git with no user or system configuration (so no hook, signing or template of the machine's
 * applies), signing off and a fixed identity, as `tests/check-remote.test.ts` runs it.
 */
const runGit = (repository: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      repository,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

export type PreparedRelations = Readonly<{
  round: RelationsRound;
  base: RelationsIndex;
  head: RelationsIndex;
  outcomes: RelationsRound["outcomes"];
  /** The round's wall time in this call, milliseconds. */
  wallMs: number;
}>;

/**
 * The fixture for one test file: its own repository, store and Graph folder in a temporary
 * directory, removed after the file's tests (it registers `afterAll`). Call it once at a test
 * file's top level. Everything that reads is memoized per fixture, so `prepared()` runs the
 * relations round once per test file; several test files each have their own.
 */
export const useRelationsFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "relations-fixture-"));
  const repository = join(root, "repo");
  mkdirSync(repository, { recursive: true });
  const git = (...args: string[]) => runGit(repository, ...args);
  const put = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repository, path, ".."), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
  };
  const remove = (paths: readonly string[]) => {
    for (const path of paths) git("rm", "-q", path);
  };
  git("init", "-q");
  put(BASE_FILES);
  git("add", "-A");
  git("commit", "-qm", "base");
  const branchPoint = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "review");
  put(HEAD_CHANGES);
  remove(
    Object.keys(BASE_FILES).filter((path) => !(path in FIXTURE_FILES.head)),
  );
  git("add", "-A");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  put(BASE_BRANCH_LATER);
  git("add", "-A");
  git("commit", "-qm", "the base branch moves on");
  const baseTip = git("rev-parse", "HEAD");
  const base = git("merge-base", baseTip, head);
  if (base !== branchPoint) throw new Error("the merge base moved");
  const headTree = git("rev-parse", `${head}^{tree}`);
  const baseTree = git("rev-parse", `${base}^{tree}`);

  const location = storeLocationIn(join(root, "records"));
  const graphDirectory = relationsGraphDirectory(location);
  const runtime = ManagedRuntime.make(
    Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(
        Layer.effectDiscard(Store.prepareForWrite).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Layer.provideMerge(BunFileSystem.layer),
    ),
  );

  const preparedBy = new Map<string, Promise<PreparedRelations>>();
  let testsOnce: Promise<SliceTestFiles> | undefined;
  const slicesBy = new Map<string, Promise<readonly RelationSlice[]>>();

  /**
   * Runs the relations round once per engine (this fixture's `source` unless another is given);
   * both sides must be read (`computed` or `stored`). Another engine's index is stored under its own
   * key in the same store.
   */
  const prepared = (engine: OutlineSource = source) => {
    const key = JSON.stringify(engine.key);
    let once = preparedBy.get(key);
    if (once === undefined) {
      once = prepare(engine);
      preparedBy.set(key, once);
    }
    return once;
  };
  const prepare = async (engine: OutlineSource): Promise<PreparedRelations> => {
    if (engine === source) relationsGraph.require();
    const started = performance.now();
    const round = await runtime.runPromise(
      relationsRound({
        repository,
        graphDirectory,
        base,
        head,
        source: engine,
        waitMs: 60_000,
      }),
    );
    const wallMs = performance.now() - started;
    if (isRelationsGap(round.base) || isRelationsGap(round.head))
      throw new Error(
        `a side of the fixture was not read: ${JSON.stringify(round.outcomes)}`,
      );
    return {
      round,
      base: round.base,
      head: round.head,
      outcomes: round.outcomes,
      wallMs,
    };
  };

  /** The declared test files at each side, by the repository's own declarations (`declarations.ts`). */
  const tests = () =>
    (testsOnce ??= (async () => {
      const declarationsAt = (revision: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const tree = yield* lsTree(repository, revision);
            return yield* readDeclarations({
              repository,
              revision,
              tree,
              paths: tree
                .filter((entry) => entry.type === "blob")
                .map((entry) => entry.path),
            });
          }),
        );
      return declaredTestFiles(
        await declarationsAt(base),
        await declarationsAt(head),
      );
    })());

  /** One slice per subject, in `subjects` order, with the declared tests, read by `engine`. */
  const slices = (engine: OutlineSource = source) => {
    const key = JSON.stringify(engine.key);
    let once = slicesBy.get(key);
    if (once === undefined) {
      once = (async () =>
        relationSlices(
          (await prepared(engine)).round,
          subjects,
          await tests(),
        ))();
      slicesBy.set(key, once);
    }
    return once;
  };

  afterAll(async () => {
    const deadline = Date.now() + 20_000;
    while (Effect.runSync(relationsReadsInFlight) > 0 && Date.now() < deadline)
      await Bun.sleep(10);
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  return {
    /** A path Git runs against: `git -C <repository> …`. HEAD is on the base branch's tip. */
    repository,
    /** The merge base of the base branch's tip and the head: the review's base. */
    base,
    /** The base branch's tip, one commit past the merge base, not in the review. */
    baseTip,
    head,
    baseTree,
    headTree,
    source,
    /** The store's location and its Graph folder, `<store>/graph`. */
    location,
    graphDirectory,
    subjects,
    expected: EXPECTED_RELATIONS,
    git,
    /** Runs an effect against the fixture's store. */
    run: runtime.runPromise.bind(runtime),
    prepared,
    tests,
    slices,
    slice: async (key: SubjectKey) =>
      (await slices()).find((entry) => entry.key === key),
    row: async (expected: ExpectedRelation, side: Side) =>
      findRow(await slices(), expected, side),
  };
};

export type RelationsFixture = ReturnType<typeof useRelationsFixture>;
