// Why (10.137): the public-surface candidate raises a unit to a person when it adds something people
// outside it come to rely on. It must read only the lines the unit itself adds, from the hunks'
// own text, and fire on an exported name, a flag, an environment variable or an option, but not on
// tests, Go's internal packages, unexported Go names, or a method on an unexported type. And it may
// only raise a lane, never lower one, so the owner's desk guard cannot break through it. Its sibling
// counts an export only where it crosses a package's public entry, read at the range's head with
// the same function the composition would use, so nothing after the reviewed revision is read.
// Rule 3's code risk floors come after it: a floor never lowers a lane, for every lane and floor,
// since a floor that lowered would send work away from a person; and with the removal floor off,
// rule 3 equals rule 2 on the same inputs. Rule 4 (14.28) reads kept findings as moves on the
// matrix; with no moves it is rule 3. Rule 5 (14.34) adds the moves a confirmed request for changes
// gives, on both axes; with no such move it is rule 4.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicEntryAt, readAtRevision } from "../src/lane-context.ts";
import {
  addedLines,
  CONFIRMED_AXES,
  confirmedMoveOf,
  ENTRY_STEPS,
  FINDING_MOVES,
  floorsOf,
  LANE_CANDIDATES,
  LANE_ORDER,
  LANE_RULE_VERSION,
  laneOf,
  MATRIX,
  movesOf,
  sectionLane,
  withPublicSurface,
  publicEntry,
  publicSurface,
  recordedLane,
  type AddedLine,
  type Axis,
  type Move,
} from "../src/lane-rule.ts";

const hunk = (path: string, newStart: number, body: string) => ({
  kind: "text",
  path,
  newPath: path,
  newStart,
  text: `@@ -${newStart},1 +${newStart},3 @@\n${body}`,
});

test("a unit's added lines are the hunk's added lines inside its own new-side ranges", () => {
  const hunks = [
    hunk(
      "a.ts",
      10,
      " keep\n-gone\n+export const one = 1;\n+const two = 2;\n keep\n",
    ),
    hunk("b.ts", 1, "+export const other = 3;\n"),
  ];
  expect(
    addedLines(
      [
        {
          kind: "lines",
          path: "a.ts",
          side: "new",
          startLine: 11,
          endLine: 11,
        },
      ],
      hunks,
    ),
  ).toEqual([{ path: "a.ts", line: 11, text: "export const one = 1;" }]);
  // Old-side ranges and whole-file ownership add no lines.
  expect(
    addedLines(
      [
        {
          kind: "lines",
          path: "a.ts",
          side: "old",
          startLine: 11,
          endLine: 11,
        },
        { kind: "whole-nontext", path: "b.ts", side: "new" },
      ],
      hunks,
    ),
  ).toEqual([]);
});

const line = (path: string, text: string): AddedLine => ({
  path,
  line: 1,
  text,
});

test("the public surface is an exported name, a flag, an environment variable or an option, outside tests and internal packages", () => {
  const fires = (path: string, text: string) =>
    publicSurface([line(path, text)]).map((hit) => hit.kind);
  expect(fires("src/a.ts", "export function run() {")).toEqual(["export"]);
  expect(fires("src/a.ts", "export { run, stop };")).toEqual(["export"]);
  expect(fires("src/a.ts", "const url = process.env.EDITOR_URL;")).toEqual([
    "environment",
  ]);
  expect(fires("src/cli.ts", "program.option('--fast', 'go fast')")).toEqual([
    "flag",
  ]);
  expect(
    fires("src/Environment.ts", "  enableThing: z.boolean().default(false),"),
  ).toEqual(["option"]);
  // An option-shaped key outside an options file is just an object literal.
  expect(fires("src/a.ts", "  enableThing: z.boolean(),")).toEqual([]);
  expect(fires("pkg/a.go", "func Run(ctx context.Context) error {")).toEqual([
    "export",
  ]);
  expect(fires("pkg/a.go", "func (s *Server) Close() error {")).toEqual([
    "export",
  ]);
  expect(fires("pkg/a.go", "type ABISet uint8")).toEqual(["export"]);
  expect(
    fires("pkg/a.go", 'd = flag.Duration("test.fuzztime", 0, "time")'),
  ).toEqual(["flag"]);
  expect(fires("pkg/a.go", 'v := os.Getenv("GOFLAGS")')).toEqual([
    "environment",
  ]);
  // A FlagSet's or Cobra's flags, and a variable read through an exported constant.
  expect(
    fires(
      "cmd/x/attach.go",
      'cmd.Flags().BoolVarP(&force, "force", "f", false, "")',
    ),
  ).toEqual(["flag"]);
  expect(
    fires("cmd/x/main.go", 'fs.BoolVar(&v, "verbose", false, "")'),
  ).toEqual(["flag"]);
  expect(fires("pkg/a.go", "v, ok := os.LookupEnv(EnvConnectTimeout)")).toEqual(
    ["environment"],
  );
  // A string-keyed call on anything but a flag receiver is not a flag: log and trace attributes,
  // or a CLI context reading a flag someone else defined.
  expect(fires("pkg/a.go", 'slog.String("session_id", id),')).toEqual([]);
  expect(
    fires("pkg/a.go", 'logger.Info("x", zap.Duration("elapsed", d))'),
  ).toEqual([]);
  expect(
    fires("pkg/a.go", 'span.SetAttributes(attribute.Int64("http.status", s))'),
  ).toEqual([]);
  expect(fires("pkg/a.go", 'name := c.String("name")')).toEqual([]);
  expect(fires("pkg/a.go", 'v := flag.Func("mode", "", parse)')).toEqual([
    "flag",
  ]);
  // Go's internal packages export no name, but their flags and variables still reach users.
  expect(
    fires(
      "src/cmd/go/internal/work/build.go",
      'cmd.Flag.BoolVar(&x, "race", false, "")',
    ),
  ).toEqual(["flag"]);
  expect(
    fires("src/cmd/go/internal/cfg/cfg.go", 'v := os.Getenv("GOFLAGS")'),
  ).toEqual(["environment"]);
  // Not public: unexported Go names, a method on an unexported type, tests, internal packages.
  expect(fires("pkg/a.go", "func run() error {")).toEqual([]);
  expect(fires("pkg/a.go", "func (di dirInfo) IsDir() bool {")).toEqual([]);
  expect(fires("pkg/a_test.go", "func TestRun(t *testing.T) {")).toEqual([]);
  expect(fires("src/internal/a.go", "func Run() {")).toEqual([]);
  expect(fires("src/__tests__/a.ts", "export const fixture = 1;")).toEqual([]);
  expect(fires("src/a.test.ts", "export const helper = 1;")).toEqual([]);
  expect(fires("src/a.ts", "const local = 1;")).toEqual([]);
});

test("the live public-surface raise only lifts an agent's or automation's unit, and only to human-suggested", () => {
  const exported = [line("src/a.ts", "export const one = 1;")];
  const quiet = [line("src/a.ts", "const one = 1;")];
  expect(withPublicSurface("agentic", exported).lane).toBe("human-suggested");
  expect(withPublicSurface("static-automation", exported).lane).toBe(
    "human-suggested",
  );
  expect(withPublicSurface("human-required", exported).lane).toBe(
    "human-required",
  );
  expect(withPublicSurface("human-suggested", exported).lane).toBe(
    "human-suggested",
  );
  expect(withPublicSurface("agentic", quiet)).toEqual({
    lane: "agentic",
    hits: [],
  });
  // It is live now (10.140): no longer a candidate, so no round can apply it twice.
  expect(Object.keys(LANE_CANDIDATES)).toEqual(["public-surface-entry"]);
});

const files =
  (tree: Record<string, string>) =>
  (path: string): string | null =>
    tree[path] ?? null;

test("an exported name is a package's public entry only where the package's entry exposes it", () => {
  const read = files({
    "packages/lib/package.json": JSON.stringify({
      name: "lib",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
    }),
    "packages/lib/src/index.ts":
      'export * from "./domain.ts";\nexport { parseA, parseB as b } from "./parse.js";\nexport * as util from "./util";\n',
    "packages/lib/src/domain.ts": "export type A = 1;\n",
    "packages/lib/src/parse.ts":
      "export const parseA = 1;\nexport const parseB = 2;\nexport const parseC = 3;\n",
    "packages/lib/src/util/index.ts": "export const helper = 1;\n",
    "packages/lib/src/private.ts": "export const hidden = 1;\n",
    // An application: a package.json with no entry exposes nothing.
    "apps/web/package.json": JSON.stringify({ name: "web", private: true }),
    "apps/web/src/view.ts": "export const View = 1;\n",
    "cmd/tool/main.go": "package main\n\nfunc Run() {}\n",
    "pkg/api/api.go": "// Package api.\npackage api\n\nfunc Run() {}\n",
  });
  const isPublic = publicEntry(read);
  // A built `dist` entry is read from `src`; `export *` passes everything through.
  expect(isPublic("packages/lib/src/domain.ts", ["A"])).toBe(true);
  // Named re-exports pass only the names they name, under their local names.
  expect(isPublic("packages/lib/src/parse.ts", ["parseA"])).toBe(true);
  expect(isPublic("packages/lib/src/parse.ts", ["parseB"])).toBe(true);
  expect(isPublic("packages/lib/src/parse.ts", ["parseC"])).toBe(false);
  // A namespace re-export exposes the whole module; a file nothing re-exports is internal.
  expect(isPublic("packages/lib/src/util/index.ts", ["helper"])).toBe(true);
  expect(isPublic("packages/lib/src/private.ts", ["hidden"])).toBe(false);
  expect(isPublic("apps/web/src/view.ts", ["View"])).toBe(false);
  // Go: any package's exported names but a command's.
  expect(isPublic("cmd/tool/main.go", ["Run"])).toBe(false);
  expect(isPublic("pkg/api/api.go", ["Run"])).toBe(true);
});

test("public-surface-entry counts exports only through a package's entry, and flags, variables and options anywhere", () => {
  const candidate = LANE_CANDIDATES["public-surface-entry"]!;
  const entry = (path: string, names: ReadonlyArray<string>) =>
    path === "packages/lib/src/domain.ts" && names.includes("A");
  const at = (path: string, text: string) => ({
    added: [line(path, text)],
    isPublicEntry: entry,
  });
  expect(
    candidate(
      "agentic",
      at("packages/lib/src/domain.ts", "export type A = 1;"),
    ),
  ).toBe("human-suggested");
  expect(
    candidate("agentic", at("apps/web/src/view.ts", "export const View = 1;")),
  ).toBe("agentic");
  expect(
    candidate(
      "agentic",
      at("apps/web/src/env.ts", "const u = process.env.API_URL;"),
    ),
  ).toBe("human-suggested");
  // Without the entry check, no export counts.
  expect(
    candidate("agentic", {
      added: [line("packages/lib/src/domain.ts", "export type A = 1;")],
    }),
  ).toBe("agentic");
  // Stories and test helpers are never surface; a variable merely ending in "fs" is no flag set.
  expect(
    publicSurface([
      line("src/a.stories.tsx", "export const Default: Story = {};"),
    ]),
  ).toEqual([]);
  expect(
    publicSurface([
      line("src/test-utils.ts", "export const render = () => {};"),
    ]),
  ).toEqual([]);
  expect(
    publicSurface([line("pkg/a.go", 'theme := prefs.String("theme")')]),
  ).toEqual([]);
  // An export line names what it exports.
  expect(
    publicSurface([line("src/a.ts", "export { a, b as c, type D };")])[0]
      ?.names,
  ).toEqual(["a", "c", "D"]);
  expect(
    publicSurface([line("src/a.ts", "export default function main() {}")])[0]
      ?.names,
  ).toEqual(["default"]);
  expect(
    publicSurface([line("pkg/a.go", "func (s *Server) Close() error {")])[0]
      ?.names,
  ).toEqual(["Close"]);
});

test("a range's head is read as it stood: no later revision's files reach the package-entry check", () => {
  const repo = mkdtempSync(join(tmpdir(), "lane-context-"));
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  try {
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ main: "./src/index.ts" }),
    );
    writeFileSync(join(repo, "src/index.ts"), 'export * from "./a.ts";\n');
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src/b.ts"), "export const b = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "first",
    );
    const first = git("rev-parse", "HEAD");
    // A later revision re-exports b; read at the first, b stays internal.
    writeFileSync(
      join(repo, "src/index.ts"),
      'export * from "./a.ts";\nexport * from "./b.ts";\n',
    );
    writeFileSync(join(repo, "src/later.ts"), "export const later = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "later",
    );
    const later = git("rev-parse", "HEAD");
    const atFirst = readAtRevision(repo, first);
    expect(atFirst("src/later.ts")).toBeNull();
    expect(atFirst("src/index.ts")).toBe('export * from "./a.ts";\n');
    expect(publicEntryAt(repo, first)("src/b.ts", ["b"])).toBe(false);
    expect(publicEntryAt(repo, later)("src/b.ts", ["b"])).toBe(true);
    expect(() => readAtRevision(repo, "HEAD")).toThrow("full object id");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a package's entry is followed through imported names, folders' indexes and live code only", () => {
  const isPublic = publicEntry(
    files({
      "package.json": JSON.stringify({ main: "./src/React.js" }),
      // React's own shape: names imported, then exported from the entry.
      "src/React.js":
        'import {useState, useEffect as effect} from "./ReactHooks";\nimport * as Children from "./ReactChildren";\nimport createRoot from "./createRoot";\n// export * from "./Old";\n/* export { hidden } from "./Hidden"; */\nexport {useState, effect as useEffect, Children};\nexport default createRoot;\n',
      "src/ReactHooks.js":
        "export function useState() {}\nexport function useEffect() {}\nexport function useInternal() {}\n",
      "src/ReactChildren.js": "export const map = 1;\n",
      "src/createRoot.js": "export default function createRoot() {}\n",
      "src/Old.js": "export const old = 1;\n",
      "src/Hidden.js": "export const hidden = 1;\n",
    }),
  );
  expect(isPublic("src/ReactHooks.js", ["useState"])).toBe(true);
  expect(isPublic("src/ReactHooks.js", ["useEffect"])).toBe(true);
  expect(isPublic("src/ReactHooks.js", ["useInternal"])).toBe(false);
  expect(isPublic("src/ReactChildren.js", ["map"])).toBe(true);
  expect(isPublic("src/createRoot.js", ["default"])).toBe(true);
  // A commented-out re-export exposes nothing.
  expect(isPublic("src/Old.js", ["old"])).toBe(false);
  expect(isPublic("src/Hidden.js", ["hidden"])).toBe(false);
  // `export const enum` names its enum, and a note inside a list is no name.
  expect(
    publicSurface([line("src/a.ts", "export const enum Mode { A }")])[0]?.names,
  ).toEqual(["Mode"]);
  expect(
    publicSurface([line("src/a.ts", "export { a, /* note */ b };")])[0]?.names,
  ).toEqual(["a", "b"]);
});

test("through git, a folder is no file: a re-export of a folder reaches its index", () => {
  const repo = mkdtempSync(join(tmpdir(), "lane-folder-"));
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  try {
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "src/util"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ exports: { ".": "./src/index.ts" } }),
    );
    writeFileSync(join(repo, "src/index.ts"), 'export * from "./util";\n');
    writeFileSync(
      join(repo, "src/util/index.ts"),
      'export * from "./deep.ts";\nexport const helper = 1;\n',
    );
    writeFileSync(join(repo, "src/util/deep.ts"), "export const deep = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "one",
    );
    const head = git("rev-parse", "HEAD");
    expect(readAtRevision(repo, head)("src/util")).toBeNull();
    const isPublic = publicEntryAt(repo, head);
    expect(isPublic("src/util/index.ts", ["helper"])).toBe(true);
    expect(isPublic("src/util/deep.ts", ["deep"])).toBe(true);
    // A clone that lacks the head fails at once, never reading every path as missing.
    expect(() => readAtRevision(repo, "0".repeat(40))).toThrow(
      "holds no commit",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a package whose re-exports run past the step bound is read in part and says so", () => {
  const tree: Record<string, string> = {
    "pkg/package.json": JSON.stringify({ main: "./src/f0.ts" }),
  };
  // A chain longer than the bound: each file re-exports the next.
  for (let i = 0; i <= ENTRY_STEPS + 5; i++)
    tree[`pkg/src/f${i}.ts`] =
      `export * from "./f${i + 1}.ts";\nexport const v${i} = 1;\n`;
  const isPublic = publicEntry(files(tree));
  expect(isPublic("pkg/src/f1.ts", ["v1"])).toBe(true);
  expect(isPublic.truncated()).toEqual(["pkg"]);
  const small = publicEntry(
    files({
      "package.json": JSON.stringify({ main: "./index.ts" }),
      "index.ts": "export const x = 1;\n",
    }),
  );
  expect(small("index.ts", ["x"])).toBe(true);
  expect(small.truncated()).toEqual([]);
});

/** Assessments `laneOf` places in each lane, with and without a gap and a lean. */
const assessments = (["low", "high"] as const).flatMap((complexity) =>
  (["easy", "hard"] as const).flatMap((ease) =>
    (["missing", "solid"] as const).flatMap((coverage) =>
      [false, true].flatMap((gap) =>
        (["agentic", "human-suggested"] as const).map((lean) => ({
          complexity: {
            level: complexity,
            factors: [{ cites: ["a.ts:new:1-1"] }],
          },
          validation: {
            level: ease,
            requirements: [
              { cites: ["a.ts:new:1-1"], coverage, requirement: "It parses." },
            ],
          },
          lean: { lane: lean, reason: "said so" },
          gaps: gap ? [{ axis: "ease-of-validation" as const }] : [],
        })),
      ),
    ),
  ),
);

test("a code risk floor never lowers a lane, and with the removal floor off rule 3 is rule 2", () => {
  const surfaces = [
    [line("src/a.ts", "const one = 1;")],
    [line("src/a.ts", "export const one = 1;")],
  ];
  const seen = new Set<string>();
  for (const assessment of assessments)
    for (const added of surfaces) {
      const rule2 = withPublicSurface(laneOf(assessment).lane, added).lane;
      seen.add(rule2);
      for (const to of LANE_ORDER) {
        const trail = sectionLane({
          assessment,
          added,
          floors: [{ rule: "removal", to }],
        });
        expect(trail.surfaced).toBe(rule2);
        expect(LANE_ORDER.indexOf(trail.applied)).toBeGreaterThanOrEqual(
          Math.max(LANE_ORDER.indexOf(rule2), LANE_ORDER.indexOf(to)),
        );
        expect(trail.floors.length).toBe(
          LANE_ORDER.indexOf(to) > LANE_ORDER.indexOf(rule2) ? 1 : 0,
        );
      }
      const facts = {
        removesDeclaration: true,
        removesPublicName: true,
        effects: ["removed", "disabled", "narrowed"] as const,
      };
      // Off: no floor, and rule 3 gives rule 2's lane.
      expect(floorsOf(facts, {})).toEqual([]);
      expect(
        sectionLane({ assessment, added, floors: floorsOf(facts, {}) }).applied,
      ).toBe(rule2);
    }
  // The assessments reach every lane, so every lane was checked under every floor.
  expect([...seen].sort()).toEqual([...LANE_ORDER].sort());
  const on = { removal: true };
  const none = { removesDeclaration: false, removesPublicName: false };
  expect(floorsOf({ ...none, effects: ["changed", "added"] }, on)).toEqual([]);
  for (const facts of [
    { ...none, removesDeclaration: true, effects: [] },
    { ...none, removesPublicName: true, effects: [] },
    { ...none, effects: ["disabled" as const] },
    { ...none, effects: ["narrowed" as const] },
  ])
    expect(floorsOf(facts, on)).toEqual([
      { rule: "removal", to: "human-suggested" },
    ]);
});

/**
 * Lane rule 3's `laneOf`, frozen as it stood at `25ff5e89` (before the matrix), as the oracle that
 * rule 4 with no moves must equal byte for byte.
 */
const rule3LaneOf = (assessment: Parameters<typeof laneOf>[0]) => {
  const quadrant =
    `${assessment.complexity.level}-${assessment.validation.level}` as const;
  const citedComplexity = assessment.complexity.factors.some(
    (factor) => factor.cites.length > 0,
  );
  const citedValidation = assessment.validation.requirements.some(
    (requirement) => requirement.cites.length > 0,
  );
  const validationGap = assessment.gaps.some(
    (gap) => gap.axis === "ease-of-validation",
  );
  let lane: (typeof LANE_ORDER)[number];
  let note: string;
  switch (quadrant) {
    case "low-easy": {
      const open = assessment.validation.requirements.filter(
        (r) => r.coverage !== "solid",
      );
      if (assessment.validation.requirements.length > 0 && open.length === 0) {
        lane = "static-automation";
        note =
          "low and easy, every validation requirement solid (two or more current kinds agree): static automation (10.82)";
      } else {
        lane = "agentic";
        note = `low and easy: agentic; static automation needs every validation requirement solid, and ${open.length === 0 ? "no requirement is stated" : open.map((r) => `"${r.requirement.slice(0, 80)}" is ${r.coverage}`).join("; ")} (10.82)`;
      }
      break;
    }
    case "low-hard":
      lane = "human-suggested";
      note = "low complexity, hard to validate: human-suggested";
      break;
    case "high-easy":
      lane =
        assessment.lean?.lane === "human-suggested"
          ? "human-suggested"
          : "agentic";
      note =
        lane === "human-suggested"
          ? `high complexity, easy to validate: human-suggested, as the lean asks (${assessment.lean!.reason})`
          : "high complexity, easy to validate: agentic";
      break;
    case "high-hard":
      lane = "human-required";
      note = "high complexity, hard to validate: human-required";
      break;
  }
  if (assessment.gaps.length > 0) {
    if (quadrant === "high-hard" && citedComplexity && citedValidation) {
      note +=
        "; its gaps cannot lower it, since cited evidence places it high and hard (10.9)";
    } else {
      lane = "human-suggested";
      note += `; a gap on ${[...new Set(assessment.gaps.map((gap) => gap.axis))].join(" and ")} sends it to human-suggested (4.4)`;
    }
  }
  const highComplexityValidationGap =
    lane === "human-suggested" &&
    assessment.complexity.level === "high" &&
    citedComplexity &&
    validationGap;
  if (highComplexityValidationGap)
    note += "; evidence of high complexity with a validation gap (10.55)";
  return { quadrant, lane, note, highComplexityValidationGap };
};

/** Every assessment above, also with no lean, no cites and gaps on either axis. */
const wider = assessments.flatMap((a) => [
  a,
  { ...a, lean: null },
  {
    ...a,
    complexity: { ...a.complexity, factors: [{ cites: [] }] },
    validation: {
      ...a.validation,
      requirements: a.validation.requirements.map((r) => ({ ...r, cites: [] })),
    },
  },
  { ...a, gaps: [{ axis: "complexity" as const }] },
]);

const move = (
  axis: Move["axis"],
  cites: ReadonlyArray<string> = ["risky-edges.1"],
): Move => ({
  signal: "kept-finding",
  axis,
  direction: "toward-human",
  cites,
});

// Reason (14.28, rule 4 = rule 3 without moves): the matrix replaced the switch, and stored rule 3
// lanes must recompute unchanged, so with no move (absent or empty) every quadrant, lean, gap and
// cite pattern gives exactly the old lane, note, quadrant and flag.
test("with no moves, lane rule 4's laneOf is rule 3's byte for byte", () => {
  for (const assessment of wider) {
    const oracle = rule3LaneOf(assessment);
    expect(laneOf(assessment)).toEqual(oracle);
    expect(laneOf({ ...assessment, movement: [] })).toEqual(oracle);
  }
});

// Reason (14.28): each cell of the matrix is the lane 4.2 and 10.82 give it, and a move raises its
// axis one step, to the top level, so the cell it lands in decides the lane.
test("each cell of the matrix gives its lane, and a move raises its axis to the top", () => {
  const base = (
    complexity: "low" | "high",
    ease: "easy" | "hard",
    coverage: "solid" | "missing",
  ) => ({
    complexity: { level: complexity, factors: [{ cites: ["a.ts:new:1-1"] }] },
    validation: {
      level: ease,
      requirements: [
        { cites: ["a.ts:new:1-1"], coverage, requirement: "It parses." },
      ],
    },
    lean: null,
    gaps: [],
  });
  expect(MATRIX).toEqual({
    "low-easy": "by-proof",
    "low-hard": "human-suggested",
    "high-easy": "by-lean",
    "high-hard": "human-required",
  });
  const cell = (a: Parameters<typeof laneOf>[0]) => {
    const out = laneOf(a);
    return [out.quadrant, out.lane];
  };
  expect(cell(base("low", "easy", "solid"))).toEqual([
    "low-easy",
    "static-automation",
  ]);
  expect(cell(base("low", "easy", "missing"))).toEqual(["low-easy", "agentic"]);
  expect(cell(base("low", "hard", "solid"))).toEqual([
    "low-hard",
    "human-suggested",
  ]);
  expect(cell(base("high", "easy", "solid"))).toEqual(["high-easy", "agentic"]);
  expect(cell(base("high", "hard", "solid"))).toEqual([
    "high-hard",
    "human-required",
  ]);
  // A move on complexity: low becomes high; on validation: easy becomes hard. Never lowered.
  const low = base("low", "easy", "solid");
  expect(cell({ ...low, movement: [move("complexity")] })).toEqual([
    "high-easy",
    "human-suggested",
  ]);
  expect(cell({ ...low, movement: [move("ease-of-validation")] })).toEqual([
    "low-hard",
    "human-suggested",
  ]);
  expect(
    cell({
      ...low,
      movement: [move("complexity"), move("ease-of-validation")],
    }),
  ).toEqual(["high-hard", "human-required"]);
  // A move on an axis already at the top changes no cell.
  const top = base("high", "hard", "solid");
  expect(
    cell({
      ...top,
      movement: [move("complexity"), move("ease-of-validation")],
    }),
  ).toEqual(["high-hard", "human-required"]);
  // Every lane under moves is at least the lane without them: a move only raises.
  for (const assessment of wider)
    for (const movement of [
      [move("complexity")],
      [move("ease-of-validation")],
      [move("complexity"), move("ease-of-validation")],
    ])
      expect(
        LANE_ORDER.indexOf(laneOf({ ...assessment, movement }).lane),
      ).toBeGreaterThanOrEqual(LANE_ORDER.indexOf(laneOf(assessment).lane));
});

// Reason (14.28, rulings 1 and 4): the kind and what a finding is about set the axis it moves; a
// pattern note moves nothing (9.10), and the finder's own severity is never read.
test("each finding kind moves its axis by what it is about, and a pattern note gives no move", () => {
  const kinds = ["defect", "risk", "question", "pattern-note"] as const;
  const abouts = ["code", "tests", "proof"] as const;
  for (const kind of kinds)
    for (const about of abouts) {
      const moves = movesOf([{ id: `${kind}.${about}`, kind, about }]);
      expect({ kind, about, moves }).toEqual({
        kind,
        about,
        moves:
          kind === "pattern-note"
            ? []
            : [
                {
                  signal: "kept-finding",
                  axis: about === "code" ? "complexity" : "ease-of-validation",
                  direction: "toward-human",
                  cites: [`${kind}.${about}`],
                },
              ],
      });
      expect(FINDING_MOVES[kind][about]).toBe(
        kind === "pattern-note"
          ? null
          : about === "code"
            ? "complexity"
            : "ease-of-validation",
      );
    }
  // One move per finding, in the order given.
  expect(
    movesOf([
      { id: "a", kind: "risk", about: "code" },
      { id: "b", kind: "pattern-note", about: "code" },
      { id: "c", kind: "question", about: "tests" },
    ]).map((m) => m.cites[0]),
  ).toEqual(["a", "c"]);
});

// Reason (ruling 3): in the high and easy cell the reading's answer that no person is needed was
// given without the finding, so a move voids it; the reading's own ask for a person stands.
test("a move voids an agentic answer in the high and easy cell", () => {
  const highEasy = {
    complexity: {
      level: "high" as const,
      factors: [{ cites: ["a.ts:new:1-1"] }],
    },
    validation: {
      level: "easy" as const,
      requirements: [
        {
          cites: ["a.ts:new:1-1"],
          coverage: "solid" as const,
          requirement: "It parses.",
        },
      ],
    },
    gaps: [],
  };
  for (const lean of [
    null,
    { lane: "agentic" as const, reason: "no person needed" },
  ]) {
    expect(laneOf({ ...highEasy, lean }).lane).toBe("agentic");
    const voided = laneOf({
      ...highEasy,
      lean,
      movement: [move("complexity")],
    });
    expect(voided.lane).toBe("human-suggested");
    expect(voided.note).toContain("the reading never saw the kept finding");
  }
  const asked = laneOf({
    ...highEasy,
    lean: { lane: "human-suggested", reason: "a person should look" },
    movement: [move("complexity")],
  });
  expect(asked.lane).toBe("human-suggested");
  expect(asked.note).toContain("as the lean asks (a person should look)");
});

// Reason (ruling 2, 10.9): a kept finding's cites are cited evidence on its axis, so a section high
// and hard by a move keeps human-required through a gap only when both axes are cited; without the
// cites the gap still sends it to human-suggested.
test("a move's cites count as cited evidence for 10.9", () => {
  const uncited = {
    complexity: { level: "low" as const, factors: [{ cites: [] }] },
    validation: {
      level: "easy" as const,
      requirements: [
        { cites: [], coverage: "missing" as const, requirement: "It parses." },
      ],
    },
    lean: null,
    gaps: [{ axis: "ease-of-validation" as const }],
  };
  // Both axes raised and cited by the moves alone: human-required through the gap.
  const cited = laneOf({
    ...uncited,
    movement: [move("complexity"), move("ease-of-validation", ["tests.1"])],
  });
  expect([cited.quadrant, cited.lane]).toEqual(["high-hard", "human-required"]);
  expect(cited.note).toContain("cited evidence places it high and hard");
  // A move with no cites is no cited evidence: the gap wins.
  const bare = laneOf({
    ...uncited,
    movement: [move("complexity", []), move("ease-of-validation", [])],
  });
  expect([bare.quadrant, bare.lane]).toEqual(["high-hard", "human-suggested"]);
  // One axis cited by the reading, the other only by a move: cited on both.
  const mixed = laneOf({
    ...uncited,
    complexity: { level: "high", factors: [{ cites: ["a.ts:new:1-1"] }] },
    movement: [move("ease-of-validation", ["tests.1"])],
  });
  expect(mixed.lane).toBe("human-required");
  // The 10.55 flag: high by a cited move, with a validation gap, sent to human-suggested.
  const flagged = laneOf({ ...uncited, movement: [move("complexity")] });
  expect([flagged.lane, flagged.highComplexityValidationGap]).toEqual([
    "human-suggested",
    true,
  ]);
});

// ---------------------------------------------------------------------------------------------
// Lane rule 5 (14.34): a confirmed request for changes also makes validation hard
// ---------------------------------------------------------------------------------------------

/** Lane rule 4's `laneOf` as it was at the second-release head, kept as the oracle rule 5 must equal. */
const rule4LaneOf = (assessment: {
  readonly complexity: {
    readonly level: "low" | "high";
    readonly factors: ReadonlyArray<{ readonly cites: ReadonlyArray<string> }>;
  };
  readonly validation: {
    readonly level: "easy" | "hard";
    readonly requirements: ReadonlyArray<{
      readonly cites: ReadonlyArray<string>;
      readonly coverage: "missing" | "shallow" | "solid";
      readonly requirement: string;
    }>;
  };
  readonly lean: {
    readonly lane: "agentic" | "human-suggested";
    readonly reason: string;
  } | null;
  readonly gaps: ReadonlyArray<{
    readonly axis: "complexity" | "ease-of-validation";
  }>;
  /** The moves on the section; absent, none (lane rules 1 to 3). */
  readonly movement?: ReadonlyArray<Move> | undefined;
}) => {
  const moves = assessment.movement ?? [];
  const on = (axis: Axis) => moves.filter((move) => move.axis === axis);
  const complexity =
    on("complexity").length > 0 ? "high" : assessment.complexity.level;
  const validation =
    on("ease-of-validation").length > 0 ? "hard" : assessment.validation.level;
  const quadrant = `${complexity}-${validation}` as const;
  const citedComplexity =
    assessment.complexity.factors.some((factor) => factor.cites.length > 0) ||
    on("complexity").some((move) => move.cites.length > 0);
  const citedValidation =
    assessment.validation.requirements.some(
      (requirement) => requirement.cites.length > 0,
    ) || on("ease-of-validation").some((move) => move.cites.length > 0);
  const validationGap = assessment.gaps.some(
    (gap) => gap.axis === "ease-of-validation",
  );
  let lane: (typeof LANE_ORDER)[number];
  let note: string;
  const cell = MATRIX[quadrant];
  if (cell === "by-proof") {
    const open = assessment.validation.requirements.filter(
      (r) => r.coverage !== "solid",
    );
    if (assessment.validation.requirements.length > 0 && open.length === 0) {
      lane = "static-automation";
      note =
        "low and easy, every validation requirement solid (two or more current kinds agree): static automation (10.82)";
    } else {
      lane = "agentic";
      note = `low and easy: agentic; static automation needs every validation requirement solid, and ${open.length === 0 ? "no requirement is stated" : open.map((r) => `"${r.requirement.slice(0, 80)}" is ${r.coverage}`).join("; ")} (10.82)`;
    }
  } else if (cell === "by-lean") {
    lane =
      assessment.lean?.lane === "human-suggested" || moves.length > 0
        ? "human-suggested"
        : "agentic";
    note =
      assessment.lean?.lane === "human-suggested"
        ? `high complexity, easy to validate: human-suggested, as the lean asks (${assessment.lean.reason})`
        : lane === "human-suggested"
          ? "high complexity, easy to validate: human-suggested, since the reading never saw the kept finding (14.28)"
          : "high complexity, easy to validate: agentic";
  } else {
    lane = cell;
    note =
      cell === "human-suggested"
        ? "low complexity, hard to validate: human-suggested"
        : "high complexity, hard to validate: human-required";
  }
  if (moves.length > 0)
    note += `; ${[...new Set(moves.map((move) => move.axis))].map((axis) => (axis === "complexity" ? "a kept finding about the code raises its complexity" : "a kept finding about its tests or proof makes it hard to validate")).join(", and ")} (14.28)`;
  if (assessment.gaps.length > 0) {
    if (quadrant === "high-hard" && citedComplexity && citedValidation) {
      note +=
        "; its gaps cannot lower it, since cited evidence places it high and hard (10.9)";
    } else {
      lane = "human-suggested";
      note += `; a gap on ${[...new Set(assessment.gaps.map((gap) => gap.axis))].join(" and ")} sends it to human-suggested (4.4)`;
    }
  }
  const highComplexityValidationGap =
    lane === "human-suggested" &&
    complexity === "high" &&
    citedComplexity &&
    validationGap;
  if (highComplexityValidationGap)
    note += "; evidence of high complexity with a validation gap (10.55)";
  return { quadrant, lane, note, highComplexityValidationGap };
};

/** The moves a request for changes resting on the given confirmed claims gives: one per axis. */
const confirmed = (
  cites: ReadonlyArray<string> = ["correctness.1"],
): Array<Move> =>
  (["complexity", "ease-of-validation"] as const).map((axis) => ({
    signal: "confirmed-request-changes",
    axis,
    direction: "toward-human",
    cites,
  }));

// Reason (14.34, rule 5 = rule 4 without the new moves): the rule may change a lane only where a
// confirmed request for changes stands. So over the existing assessment fixture (every quadrant,
// lean, gap and cite pattern) with every set of kept-finding moves, rule 5's laneOf gives rule 4's
// lane, note, quadrant and flag byte for byte; and no verdict but a request resting on a confirmed
// claim gives the moves at all.
test("with no confirmed request for changes, lane rule 5 is rule 4 byte for byte", () => {
  expect(LANE_RULE_VERSION).toBe(5);
  const keptSets: ReadonlyArray<ReadonlyArray<Move>> = [
    [],
    [move("complexity")],
    [move("ease-of-validation", ["tests.1"])],
    [move("complexity"), move("ease-of-validation", [])],
  ];
  for (const assessment of wider)
    for (const movement of keptSets)
      expect(laneOf({ ...assessment, movement })).toEqual(
        rule4LaneOf({ ...assessment, movement }),
      );
  expect(confirmedMoveOf("approve", [])).toEqual([]);
  expect(confirmedMoveOf("approve", ["c1"])).toEqual([]);
  expect(confirmedMoveOf(null, [])).toEqual([]);
  // A request for changes resting on no confirmed claim is undecided (disagreed), never a move.
  expect(confirmedMoveOf("request-changes", [])).toEqual([]);
  // 14.34, both axes: one move each, both citing every claim the request rests on.
  expect(CONFIRMED_AXES).toEqual(["complexity", "ease-of-validation"]);
  expect(confirmedMoveOf("request-changes", ["correctness.1", "c2"])).toEqual(
    confirmed(["correctness.1", "c2"]),
  );
});

// Reason (14.34, plant 101): gates ran plant 101 twice with the same section, five confirmed
// claims, kept findings about code, a request for changes and high complexity; Assess called
// validation hard once and easy once, so the section went human-required once and human-suggested
// once. Rule 5's moves make it high and hard whatever Assess said, so both runs are human-required,
// with or without a validation gap, since the confirmed claims' cites count as cited evidence for
// 10.9 on both axes.
test("plant 101's shape: a confirmed request for changes with easy validation and high complexity is human-required", () => {
  const plant = {
    complexity: {
      level: "high" as const,
      factors: [{ cites: [] }],
    },
    validation: {
      level: "easy" as const,
      requirements: [
        {
          cites: [],
          coverage: "missing" as const,
          requirement: "Login fails cleanly.",
        },
      ],
    },
    lean: null,
    gaps: [],
  };
  const kept = [move("complexity", ["correctness.1"])];
  // Rule 4: high and easy, the kept finding voids the agentic answer: human-suggested.
  expect(laneOf({ ...plant, movement: kept })).toMatchObject({
    quadrant: "high-easy",
    lane: "human-suggested",
  });
  const moved = laneOf({
    ...plant,
    movement: [
      ...kept,
      ...confirmedMoveOf("request-changes", ["correctness.1"]),
    ],
  });
  expect([moved.quadrant, moved.lane]).toEqual(["high-hard", "human-required"]);
  expect(moved.note).toBe(
    "high complexity, hard to validate: human-required; a kept finding about the code raises its complexity (14.28); a confirmed defect raises its complexity and makes it hard to validate, since its fix must be validated again (14.34)",
  );
  // With gaps on both axes and nothing the reading cited: only the confirmed claims' cites are
  // cited evidence, on both axes, so it stays human-required (10.9).
  const gapped = laneOf({
    ...plant,
    gaps: [{ axis: "ease-of-validation" }, { axis: "complexity" }],
    movement: confirmed(),
  });
  expect(gapped.lane).toBe("human-required");
  expect(gapped.note).toContain("cited evidence places it high and hard");
  // The same assessment with hard validation (the other run) gives the same lane and quadrant.
  const hard = laneOf({
    ...plant,
    validation: { ...plant.validation, level: "hard" },
    movement: [...kept, ...confirmed()],
  });
  expect([hard.quadrant, hard.lane]).toEqual([moved.quadrant, moved.lane]);
});

// Reason (4.2 and 14.34, both axes): low and hard alone is human-suggested, so a confirmed request
// for changes also raises complexity: on a low, easy section it is high and hard, human-required,
// whether the confirmed claims came from a kept finder defect about code (whose own move already
// raised complexity) or from a Lane review alone (the release lane's clean-account case).
test("a confirmed request for changes with low complexity is human-required, from a finder's or a Lane review's claims", () => {
  const low = {
    complexity: {
      level: "low" as const,
      factors: [{ cites: ["a.ts:new:1-1"] }],
    },
    validation: {
      level: "easy" as const,
      requirements: [
        {
          cites: ["a.ts:new:1-1"],
          coverage: "solid" as const,
          requirement: "It parses.",
        },
      ],
    },
    lean: null,
    gaps: [],
  };
  expect(laneOf(low).lane).toBe("static-automation");
  const finder = laneOf({
    ...low,
    movement: [
      move("complexity", ["correctness.1"]),
      ...confirmed(["correctness.1"]),
    ],
  });
  expect([finder.quadrant, finder.lane]).toEqual([
    "high-hard",
    "human-required",
  ]);
  const claims = ["a", "b", "c"].map((c) => c.repeat(64));
  const review = laneOf({ ...low, movement: confirmed(claims) });
  expect([review.quadrant, review.lane]).toEqual([
    "high-hard",
    "human-required",
  ]);
  expect(review.note).toBe(
    "high complexity, hard to validate: human-required; a confirmed defect raises its complexity and makes it hard to validate, since its fix must be validated again (14.34)",
  );
});

// Reason (14.34): the moves are stored on the section's assessment, so the lanes eval and the replay
// recompute the lane from the entry alone: recordedLane must read them, and refuse one it cannot.
test("recordedLane reads a stored confirmed request's moves, and refuses one it cannot read", () => {
  const assess = {
    complexity: {
      level: "low" as const,
      factors: [{ cites: ["a.ts:new:1-1"] }],
    },
    easeOfValidation: {
      level: "easy" as const,
      requirements: [
        {
          cites: ["a.ts:new:1-1"],
          coverage: "missing" as const,
          requirement: "",
        },
      ],
    },
    lean: null,
    gaps: [],
  };
  const lane = { floors: [] };
  expect(
    recordedLane({ assess: { ...assess, movement: [] }, lane }, []).applied,
  ).toBe("agentic");
  expect(
    recordedLane(
      {
        assess: {
          ...assess,
          movement: JSON.parse(JSON.stringify(confirmed())) as unknown[],
        },
        lane,
      },
      [],
    ),
  ).toMatchObject({
    quadrant: "high-hard",
    judged: "human-required",
    applied: "human-required",
  });
  for (const bad of [
    { ...confirmed()[0]!, direction: "away-from-human" },
    { ...confirmed()[0]!, axis: "lean" },
    { ...confirmed()[0]!, cites: [7] },
  ])
    expect(() =>
      recordedLane({ assess: { ...assess, movement: [bad] }, lane }, []),
    ).toThrow("A stored move is not one the lane rule reads");
  // An undecided entry is human-required whatever moves it holds (14.4).
  expect(
    recordedLane(
      {
        assess: { ...assess, movement: [] },
        lane,
        undecided: { cause: "unconfirmed" },
      },
      [],
    ).applied,
  ).toBe("human-required");
});

// Reason (replacing round 22's floor tests): the `finding` floor is gone, so no facts, old or new,
// give it, and a recorded entry's lane comes from its stored moves, read whole or refused.
test("no floor reads a kept finding: recordedLane reads the stored moves, refuses one it cannot read, and reads none where a row has none", () => {
  const none = {
    removesDeclaration: false,
    removesPublicName: false,
    effects: [],
  };
  // Facts stored under rule 3 may still hold `keptFinding`; it gives no floor now.
  const legacy = { ...none, keptFinding: true } as Parameters<
    typeof floorsOf
  >[0];
  for (const options of [{}, { removal: false }, { removal: true }])
    expect(floorsOf(legacy, options)).toEqual([]);
  expect(
    floorsOf({ ...none, removesDeclaration: true }, { removal: true }),
  ).toEqual([{ rule: "removal", to: "human-suggested" }]);
  const assess = {
    complexity: {
      level: "low" as const,
      factors: [{ cites: ["a.ts:new:1-1"] }],
    },
    easeOfValidation: {
      level: "easy" as const,
      requirements: [
        {
          cites: ["a.ts:new:1-1"],
          coverage: "missing" as const,
          requirement: "",
        },
      ],
    },
    lean: null,
    gaps: [],
  };
  const lane = { floors: [] };
  expect(
    recordedLane({ assess: { ...assess, movement: [] }, lane }, []).applied,
  ).toBe("agentic");
  // A row written by rule 3's `laneEntryOf` holds no `movement`: none.
  expect(recordedLane({ assess, lane }, []).applied).toBe("agentic");
  const moved = recordedLane(
    { assess: { ...assess, movement: [move("complexity")] }, lane },
    [],
  );
  expect(moved).toMatchObject({
    quadrant: "high-easy",
    judged: "human-suggested",
    floors: [],
    applied: "human-suggested",
  });
  expect(moved.note).toContain(
    "a kept finding about the code raises its complexity",
  );
  for (const bad of [
    {
      signal: "blast-radius",
      axis: "complexity",
      direction: "toward-human",
      cites: [],
    },
    {
      signal: "kept-finding",
      axis: "lean",
      direction: "toward-human",
      cites: [],
    },
    {
      signal: "kept-finding",
      axis: "complexity",
      direction: "away-from-human",
      cites: [],
    },
    {
      signal: "kept-finding",
      axis: "complexity",
      direction: "toward-human",
      cites: [1],
    },
    null,
  ])
    expect(() =>
      recordedLane({ assess: { ...assess, movement: [bad] }, lane }, []),
    ).toThrow("A stored move is not one the lane rule reads");
});

// Reason: with no assessment, an entry's lane must come from what it records, never a default: an
// undecided entry goes to a person, required; an excluded file (a lockfile or declared-generated
// file) keeps today's lane for it, human-suggested; an entry that is neither cannot be placed, and
// placing it anywhere would invent a lane.
test("an entry with no assessment is human-required when undecided, human-suggested when excluded, and an error otherwise", () => {
  const lane = { floors: [] };
  expect(
    recordedLane({ assess: null, lane, undecided: { cause: "failed" } }, []),
  ).toMatchObject({ judged: null, surfaced: null, applied: "human-required" });
  expect(
    recordedLane({ assess: null, lane, excluded: { reason: "lockfile" } }, []),
  ).toMatchObject({ judged: null, surfaced: null, applied: "human-suggested" });
  // Undecided wins over excluded: a person must decide.
  expect(
    recordedLane(
      {
        assess: null,
        lane,
        undecided: { cause: "failed" },
        excluded: { reason: "lockfile" },
      },
      [],
    ).applied,
  ).toBe("human-required");
  expect(() => recordedLane({ assess: null, lane }, [])).toThrow(
    "must be undecided or an excluded file",
  );
});
