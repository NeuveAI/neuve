// A declared test can count as evidence that lifts a gap, so the `bun test` reader must declare a
// file only from what the repository wrote: a path argument that is in the tree, or the wrapper its
// own `bunfig.toml` names. These tests pin each script form, the files that must stay undeclared,
// and this repository's own counts at a commit that stays on main.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  BUN_TEST_FILE,
  DECLARATION_GAPS,
  DECLARATIONS_RECIPE,
  bunTestRoots,
  bunfigTestPreloads,
  readDeclarations,
  treePathsOf,
} from "../src/declarations.ts";
import { lsTree, type TreeEntry } from "../src/git-objects.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { indexRecipe } from "../src/search-index.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * A scratch repository with one commit of `files`, symbolic links (path to target text) and
 * submodule links (`160000` index entries, no submodule), its tree and its paths.
 */
const repositoryWith = async (
  files: Record<string, string>,
  extra: {
    symlinks?: Record<string, string>;
    links?: ReadonlyArray<string>;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "declarations-"));
  scratch.push(root);
  const git = (...args: string[]) => {
    const out = Bun.spawnSync(["git", "-C", root, ...args], { env });
    if (out.exitCode !== 0) throw new Error("Fixture Git failed");
    return out.stdout.toString().trim();
  };
  git("init", "-q");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  for (const [path, target] of Object.entries(extra.symlinks ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  git("add", ".");
  for (const path of extra.links ?? [])
    git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},${path}`,
    );
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const revision = git("rev-parse", "HEAD");
  const tree = await Effect.runPromise(lsTree(root, revision));
  return { root, revision, tree, paths: tree.map((entry) => entry.path) };
};

const declaredTests = async (options: {
  root: string;
  revision: string;
  tree: ReadonlyArray<TreeEntry>;
  paths: ReadonlyArray<string>;
  wordBudget?: number;
}) => {
  const declarations = await Effect.runPromise(
    readDeclarations({
      repository: options.root,
      revision: options.revision,
      tree: options.tree,
      paths: options.paths,
      ...(options.wordBudget === undefined
        ? {}
        : { wordBudget: options.wordBudget }),
    }),
  );
  const tests = new Map<string, ReadonlyArray<string>>();
  for (const [path, list] of declarations.byPath) {
    const by = list
      .filter((entry) => entry.kind === "test")
      .map((entry) => entry.by);
    if (by.length > 0) tests.set(path, by);
  }
  return { tests, gaps: declarations.gaps };
};

const WRAPPER = "scripts/test-budget.ts";
const PRELOAD = `[test]\npreload = ["../../${WRAPPER}"]\n`;
const manifest = (scripts: Record<string, unknown>) =>
  JSON.stringify({ scripts });
/** A package with a test at its top and one under `tests/`. */
const pkg = (
  name: string,
  scripts: Record<string, unknown>,
  bunfig?: string,
): Record<string, string> => ({
  [`packages/${name}/package.json`]: manifest(scripts),
  [`packages/${name}/top.test.ts`]: "",
  [`packages/${name}/tests/inner.test.ts`]: "",
  ...(bunfig === undefined ? {} : { [`packages/${name}/bunfig.toml`]: bunfig }),
});
const both = (name: string) => [
  `packages/${name}/top.test.ts`,
  `packages/${name}/tests/inner.test.ts`,
];
const inner = (name: string) => [`packages/${name}/tests/inner.test.ts`];

const hostileList = JSON.stringify(
  Array.from({ length: 300 }, () => `../../${WRAPPER}`),
);
// Under the 64 KiB cap, so the parser itself must refuse it.
const deepToml = `[test]\npreload = ${"[".repeat(30_000)}${"]".repeat(30_000)}\n`;

// The cases of the investigation's table, with this repository's own script shapes.
const cases: ReadonlyArray<{
  name: string;
  scripts: Record<string, unknown>;
  bunfig?: string;
  /** A symbolic link named `bunfig.toml` with this target text, in place of a file. */
  bunfigLink?: string;
  /** More files in the package, by path under it. */
  files?: ReadonlyArray<string>;
  declared: ReadonlyArray<string>;
}> = [
  { name: "bare", scripts: { test: "bun test" }, declared: both("bare") },
  {
    name: "dir",
    scripts: { test: "bun test ./tests" },
    declared: inner("dir"),
  },
  {
    name: "timeout",
    scripts: { test: "bun test --timeout 60000 ./tests" },
    declared: inner("timeout"),
  },
  {
    name: "parallel",
    scripts: { test: "bun test --parallel --timeout 15000" },
    declared: both("parallel"),
  },
  {
    name: "host",
    scripts: {
      test: `NEUVE_TEST_SUITE_TIMEOUT_MS=300000 bun ../../${WRAPPER} --timeout 60000 ./tests`,
    },
    bunfig: PRELOAD,
    declared: inner("host"),
  },
  {
    name: "harness",
    scripts: {
      test: `bun ../../${WRAPPER} --shards=4 --shard-timings=x.json ./tests`,
    },
    bunfig: PRELOAD,
    declared: inner("harness"),
  },
  {
    name: "run",
    scripts: { test: "bun run test:unit", "test:unit": "echo unit" },
    declared: [],
  },
  {
    name: "unnamed",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: `[test]\npreload = ["./setup.ts"]\n`,
    declared: [],
  },
  {
    name: "nopreload",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: "[test]\ntimeout = 5000\n",
    declared: [],
  },
  {
    name: "malformed",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: '[test\npreload = ["../../',
    declared: [],
  },
  {
    name: "deep",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: deepToml,
    declared: [],
  },
  {
    name: "huge",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: `[test]\npreload = ${hostileList}\n`,
    declared: [],
  },
  {
    name: "nonstring",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfig: `[test]\npreload = ["../../${WRAPPER}", 1]\n`,
    declared: [],
  },
  {
    name: "nul",
    scripts: { test: `bun ../../${WRAPPER}\u0000 ./tests` },
    bunfig: `[test]\npreload = ["../../${WRAPPER}\\u0000"]\n`,
    declared: [],
  },
  {
    name: "climbs",
    scripts: { test: `bun ../../../../${WRAPPER} ./tests` },
    bunfig: `[test]\npreload = ["../../../../${WRAPPER}"]\n`,
    declared: [],
  },
  {
    name: "absolute",
    scripts: { test: `bun /${WRAPPER} ./tests` },
    bunfig: `[test]\npreload = ["/${WRAPPER}"]\n`,
    declared: [],
  },
  {
    name: "badscript",
    scripts: { test: `bun ../../${WRAPPER} ./tests`, other: 1 },
    bunfig: PRELOAD,
    declared: [],
  },
  // Its wrapper is named only by `packages/bunfig.toml` and the root's, never beside its manifest.
  {
    name: "up",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    declared: [],
  },
  // A path the tree cannot confirm makes the command declare nothing, not the package.
  {
    name: "dist",
    scripts: { test: "bun test ./dist/tests" },
    declared: [],
  },
  // The shell passes a quoted path without its quotes, so it is a root.
  {
    name: "quoted",
    scripts: { test: "bun test './tests'" },
    declared: inner("quoted"),
  },
  {
    name: "glob",
    scripts: { test: "bun test ./tests/*.test.ts" },
    declared: [],
  },
  { name: "climbout", scripts: { test: "bun test ../../.." }, declared: [] },
  { name: "args", scripts: { test: 'bun test "$@"' }, declared: [] },
  // A word not led by `./`, `../` or `/` is a filter on test files' paths in Bun, never a root: it
  // narrows nothing, so the package is declared (wider than Bun runs; round 12c, was none).
  {
    name: "filter",
    scripts: { test: "bun test integration" },
    declared: both("filter"),
  },
  // A word after a flag may be its value; the tree cannot tell, so the package is declared.
  {
    name: "bail",
    scripts: { test: "bun test --bail integration" },
    declared: both("bail"),
  },
  // The wrapper form only as the command; `bun test` anywhere, as before.
  {
    name: "echo",
    scripts: { test: `echo bun ../../${WRAPPER} ./tests` },
    bunfig: PRELOAD,
    declared: [],
  },
  {
    name: "crossenv",
    scripts: { test: "cross-env X=1 bun test ./tests" },
    declared: inner("crossenv"),
  },
  // Shell operators end a command; a redirection and its target are not arguments.
  {
    name: "pipe",
    scripts: { test: "bun test ./tests | grep src" },
    files: ["src/other.test.ts"],
    declared: inner("pipe"),
  },
  {
    name: "redirect",
    scripts: { test: "bun test ./tests > out.txt" },
    declared: inner("redirect"),
  },
  {
    name: "stderr",
    scripts: { test: "bun test ./tests 2>&1" },
    declared: inner("stderr"),
  },
  // The wrapper must be in the tree, and only `bun <file>` runs it.
  {
    name: "nowrapper",
    scripts: { test: "bun ../../scripts/missing.ts ./tests" },
    bunfig: `[test]\npreload = ["../../scripts/missing.ts"]\n`,
    declared: [],
  },
  {
    name: "bunrun",
    scripts: { test: `bun run ../../${WRAPPER} ./tests` },
    bunfig: PRELOAD,
    declared: [],
  },
  // A symbolic link's target text is never configuration, even when it is valid TOML.
  {
    name: "symlink",
    scripts: { test: `bun ../../${WRAPPER} ./tests` },
    bunfigLink: `test.preload = "../../${WRAPPER}"`,
    declared: [],
  },
  // An operator inside quotes is part of a word, never the end of a command.
  {
    name: "tpipe",
    scripts: { test: "bun test -t 'login|logout' ./tests" },
    declared: inner("tpipe"),
  },
  {
    name: "tpattern",
    scripts: { test: 'bun test --test-name-pattern "unit|smoke" ./tests' },
    declared: inner("tpattern"),
  },
  {
    name: "tamp",
    scripts: { test: "bun test -t 'a&b' ./tests" },
    declared: inner("tamp"),
  },
  {
    name: "tsemi",
    scripts: { test: "bun test -t 'a;b' ./tests" },
    declared: inner("tsemi"),
  },
  {
    name: "wpipe",
    scripts: { test: `bun ../../${WRAPPER} -t 'a|b' ./tests` },
    bunfig: PRELOAD,
    declared: inner("wpipe"),
  },
  {
    name: "echoq",
    scripts: { test: `echo "run; bun ../../${WRAPPER} ./tests ; done"` },
    bunfig: PRELOAD,
    declared: [],
  },
  // A redirection anywhere is skipped with its target, and the words after it are still read.
  {
    name: "redirfirst",
    scripts: { test: "bun test > out.txt ./tests" },
    declared: inner("redirfirst"),
  },
  {
    name: "redirglued",
    scripts: { test: "bun test ./tests>out.txt" },
    declared: inner("redirglued"),
  },
  {
    name: "redirdist",
    scripts: { test: "bun test 2>&1 ./dist/tests" },
    declared: [],
  },
  {
    name: "redirin",
    scripts: { test: "bun test < in.txt ./tests" },
    declared: inner("redirin"),
  },
  // `--` ends the flags: what follows is a positional, never a flag's value.
  {
    name: "dashdist",
    scripts: { test: "bun test -- ./dist/tests" },
    declared: [],
  },
  // After `--` a plain word is still a filter (round 12c, was none).
  {
    name: "dashfilter",
    scripts: { test: "bun test -- integration" },
    declared: both("dashfilter"),
  },
  {
    name: "dashtests",
    scripts: { test: "bun test -- ./tests" },
    declared: inner("dashtests"),
  },
  // A flag written with `=` has its value; the next word is a positional, here a filter (round 12c,
  // was none).
  {
    name: "flageq",
    scripts: { test: "bun test --timeout=5000 integration" },
    declared: both("flageq"),
  },
  // A word the shell would change is never a path.
  {
    name: "var",
    scripts: { test: "bun test $SUITE/../tests" },
    declared: [],
  },
  {
    name: "default",
    scripts: { test: "bun test ${DIR:-./tests}" },
    declared: [],
  },
  { name: "subst", scripts: { test: "bun test $(ls tests)" }, declared: [] },
  {
    name: "backtick",
    scripts: { test: "bun test `ls tests`" },
    declared: [],
  },
  // A change of directory moves the roots away from the manifest's directory.
  { name: "cd", scripts: { test: "cd tests && bun test" }, declared: [] },
  {
    name: "pushd",
    scripts: { test: "pushd tests; bun test ./tests" },
    declared: [],
  },
  // A script the reader does not fully understand declares nothing.
  {
    name: "unterminated",
    scripts: { test: "bun test './tests" },
    declared: [],
  },
  {
    name: "heredoc",
    scripts: { test: "bun test ./tests <<EOF" },
    declared: [],
  },
  { name: "paren", scripts: { test: "(bun test ./tests)" }, declared: [] },
  // `&`, a line break, `\r\n` and a backslash line continuation, read as a shell reads them.
  {
    name: "amp",
    scripts: { test: "bun test ./tests & bun test ./src" },
    files: ["src/other.test.ts"],
    declared: [...inner("amp"), "packages/amp/src/other.test.ts"],
  },
  {
    name: "newline",
    scripts: { test: "bun test ./tests\nbun test ./src" },
    files: ["src/other.test.ts"],
    declared: [...inner("newline"), "packages/newline/src/other.test.ts"],
  },
  {
    // A shell passes `./tests\r` on, so a carriage return anywhere is not understood.
    name: "crlf",
    scripts: { test: "bun test ./tests\r\nbun test ./src" },
    files: ["src/other.test.ts"],
    declared: [],
  },
  {
    name: "continued",
    scripts: { test: "bun test \\\n  ./tests" },
    declared: inner("continued"),
  },
  // A word holding `=` that is not a flag is a positional like any other.
  {
    name: "eqdir",
    scripts: { test: "bun test ./a=b" },
    files: ["a=b/x.test.ts"],
    declared: ["packages/eqdir/a=b/x.test.ts"],
  },
  { name: "eqmissing", scripts: { test: "bun test ./c=d" }, declared: [] },
  // A quoted name is not an assignment, so the command is not `bun`.
  {
    name: "quotedname",
    scripts: { test: `"X"=1 bun ../../${WRAPPER} ./tests` },
    bunfig: PRELOAD,
    declared: [],
  },
  {
    name: "envwrapper",
    scripts: { test: `X="a b" bun ../../${WRAPPER} ./tests` },
    bunfig: PRELOAD,
    declared: inner("envwrapper"),
  },
  // A change of directory the reader does not follow, inside a compound command or behind a
  // prefix, makes the script declare nothing.
  {
    name: "ifcd",
    scripts: { test: "if cd tests; then bun test; fi" },
    declared: [],
  },
  {
    name: "bracecd",
    scripts: { test: "{ cd tests; bun test; }" },
    declared: [],
  },
  { name: "bangcd", scripts: { test: "! cd tests; bun test" }, declared: [] },
  {
    name: "commandcd",
    scripts: { test: "command cd tests && bun test" },
    declared: [],
  },
  {
    name: "forcd",
    scripts: { test: "for d in tests; do cd $d; bun test; done" },
    declared: [],
  },
  { name: "envc", scripts: { test: "env -C tests bun test" }, declared: [] },
  {
    name: "evalcd",
    scripts: { test: "eval 'cd tests'; bun test" },
    declared: [],
  },
  {
    name: "builtincd",
    scripts: { test: "builtin cd tests && bun test" },
    declared: [],
  },
  { name: "xcd", scripts: { test: "X=1 cd tests && bun test" }, declared: [] },
  {
    name: "subshellcd",
    scripts: { test: "( cd tests ; bun test ; )" },
    declared: [],
  },
  // A command before the change of directory still counts, and `env` with assignments only does.
  {
    name: "aftercd",
    scripts: { test: "bun test && cd x" },
    declared: both("aftercd"),
  },
  {
    name: "envassign",
    scripts: { test: "env X=1 bun test ./tests" },
    declared: inner("envassign"),
  },
  // An expansion body, an opaque word among the arguments, `&>` and `--cwd` are not followed.
  {
    name: "dollarbrace",
    scripts: { test: "echo ${MSG:-x; bun test ./tests; }" },
    declared: [],
  },
  {
    name: "dollarbody",
    scripts: { test: "echo ${MSG:-x; bun test ./tests; x}" },
    declared: [],
  },
  {
    name: "quotedbrace",
    scripts: { test: 'echo "${MSG}"; bun test ./tests' },
    declared: [],
  },
  { name: "dollarflag", scripts: { test: "bun test --$MODE" }, declared: [] },
  {
    name: "flagvar",
    scripts: { test: "bun test --bail $FILES" },
    declared: [],
  },
  { name: "cr", scripts: { test: "bun test ./tests\r" }, declared: [] },
  {
    name: "ampgt",
    scripts: { test: "bun test ./tests &> out.txt" },
    declared: [],
  },
  {
    name: "cwd",
    scripts: { test: "bun test --cwd tests ./tests" },
    declared: [],
  },
  {
    name: "cwdeq",
    scripts: { test: "bun test --cwd=tests ./tests" },
    declared: [],
  },
  // Forms the shell changes before the program sees them, or reads differently from plain text.
  { name: "pwd", scripts: { test: 'bun test "$PWD/../tests"' }, declared: [] },
  { name: "star", scripts: { test: "bun test ./*/../tests" }, declared: [] },
  {
    name: "question",
    scripts: { test: "bun test ./?/../tests" },
    declared: [],
  },
  {
    name: "bracket",
    scripts: { test: "bun test ./[t]/../tests" },
    declared: [],
  },
  {
    name: "braceglob",
    scripts: { test: "bun test ./{x}/../tests" },
    declared: [],
  },
  { name: "tilde", scripts: { test: "bun test ~/../tests" }, declared: [] },
  {
    name: "dqbackslash",
    scripts: { test: 'bun test "./te\\sts"' },
    declared: [],
  },
  {
    name: "escpipe",
    scripts: { test: "bun test -t a\\|b ./tests" },
    declared: inner("escpipe"),
  },
  { name: "hashword", scripts: { test: "bun test ./tests#x" }, declared: [] },
  // A quoted `1` is a word, not a descriptor: Bun gets it as a filter, which narrows nothing, so
  // `./tests` is the root (round 12c, was none: the word was an unconfirmed path then).
  {
    name: "quotedfd",
    scripts: { test: "bun test ./tests '1'>out.txt" },
    declared: inner("quotedfd"),
  },
  // After `--`, both words are positionals and neither is a path: filters (round 12c, was none).
  {
    name: "dashflag",
    scripts: { test: "bun test -- --bail integration" },
    declared: both("dashflag"),
  },
  // Bun's ignore patterns take files out of a run; the reader does not apply patterns.
  {
    name: "pathignore",
    scripts: { test: "bun test ./tests --path-ignore-patterns='x/**'" },
    declared: [],
  },
  {
    name: "pathignoreword",
    scripts: { test: "bun test --path-ignore-patterns 'x/**' ./tests" },
    declared: [],
  },
  // A variable as a command word may be `cd`, or any other command.
  {
    name: "govar",
    scripts: { test: "GO=cd; $GO tests; bun test" },
    declared: [],
  },
  { name: "govar2", scripts: { test: "$GO tests && bun test" }, declared: [] },
  // An operator with no command before it, or after `&&`, `||` and `|`, is a script a shell
  // refuses; a trailing `;` or line break, and a line break after `&&`, are accepted.
  { name: "leadingand", scripts: { test: "&& bun test" }, declared: [] },
  {
    name: "trailingand",
    scripts: { test: "bun test ./tests &&" },
    declared: [],
  },
  { name: "trailingpipe", scripts: { test: "bun test |" }, declared: [] },
  { name: "triplepipe", scripts: { test: "bun test ||| true" }, declared: [] },
  {
    name: "trailingsemi",
    scripts: { test: "bun test ./tests;" },
    declared: inner("trailingsemi"),
  },
  {
    name: "trailingline",
    scripts: { test: "bun test ./tests\n" },
    declared: inner("trailingline"),
  },
  {
    name: "andline",
    scripts: { test: "bun test ./tests &&\n bun test ./src" },
    files: ["src/other.test.ts"],
    declared: [...inner("andline"), "packages/andline/src/other.test.ts"],
  },
  // A root never takes a sibling whose name starts with the root's name.
  {
    name: "sibling",
    scripts: { test: "bun test ./tests" },
    files: ["tests0/x.test.ts", "tests-x/y.test.ts"],
    declared: inner("sibling"),
  },
  // `source`, `.` and `exec` run other text or replace the shell: not followed.
  {
    name: "sourcecmd",
    scripts: { test: "source x; bun test ./tests" },
    declared: [],
  },
  { name: "dotcmd", scripts: { test: ". x; bun test ./tests" }, declared: [] },
  // A `bunfig.toml` whose `[test]` table the reader cannot see may narrow what Bun runs, so the
  // `bun test` form declares nothing beside it either; one with no `test` key changes nothing.
  {
    name: "badtoml",
    scripts: { test: "bun test ./tests" },
    bunfig: '[test\npreload = ["../../',
    declared: [],
  },
  {
    name: "testnottable",
    scripts: { test: "bun test ./tests" },
    bunfig: "test = 1\n",
    declared: [],
  },
  {
    name: "notesttable",
    scripts: { test: "bun test ./tests" },
    bunfig: '[install]\nregistry = "https://registry.example.invalid"\n',
    declared: inner("notesttable"),
  },
  {
    name: "execcmd",
    scripts: { test: "exec bun test ./tests" },
    declared: [],
  },
];

// Why: each script form must declare exactly the files its roots hold, and every form the
// repository did not write (a run of another script, an unnamed or unreadable wrapper, a hostile
// configuration, a path it cannot confirm, a printed or symbolic-link form) must declare nothing
// and never throw.
test("each script form declares the files its own roots hold", async () => {
  const files: Record<string, string> = {
    [WRAPPER]: "",
    "packages/bunfig.toml": `[test]\npreload = ["../${WRAPPER}"]\n`,
  };
  const symlinks: Record<string, string> = {};
  for (const entry of cases) {
    Object.assign(files, pkg(entry.name, entry.scripts, entry.bunfig));
    for (const path of entry.files ?? [])
      files[`packages/${entry.name}/${path}`] = "";
    if (entry.bunfigLink !== undefined)
      symlinks[`packages/${entry.name}/bunfig.toml`] = entry.bunfigLink;
  }
  const repository = await repositoryWith(files, { symlinks });
  expect(
    repository.tree.find(
      (entry) => entry.path === "packages/symlink/bunfig.toml",
    )?.mode,
  ).toBe("120000");
  const { tests, gaps } = await declaredTests(repository);
  // The `malformed`, `deep` and `badtoml` rows' files are not valid TOML.
  expect(gaps).toEqual([
    ...DECLARATION_GAPS,
    "package-scripts-bun-test: 3 bunfig.toml file(s) are not valid TOML; the test roots of the manifests beside them were not checked",
  ]);
  for (const entry of cases) {
    const declared = [...tests.keys()].filter((path) =>
      path.startsWith(`packages/${entry.name}/`),
    );
    expect({ name: entry.name, declared: declared.sort() }).toEqual({
      name: entry.name,
      declared: [...entry.declared].sort(),
    });
  }
  // A suggestion names the manifest and script, and for a wrapper the file and its bunfig.toml.
  expect(tests.get("packages/dir/tests/inner.test.ts")).toEqual([
    `package-scripts-bun-test: packages/dir/package.json script "test", Bun's test-file rule`,
  ]);
  expect(tests.get("packages/harness/tests/inner.test.ts")).toEqual([
    `package-scripts-bun-test: packages/harness/package.json script "test" runs ${WRAPPER}, which packages/harness/bunfig.toml names in [test].preload, Bun's test-file rule`,
  ]);
  // A flag's value the tree does not have is not a root.
  const tree = treePathsOf(repository.tree);
  expect(
    bunTestRoots(
      "packages/timeout/package.json",
      manifest({ test: "bun test --timeout 60000 ./tests" }),
      { tree },
    ),
  ).toEqual([{ root: "packages/timeout/tests", script: "test" }]);
  expect(
    bunTestRoots(
      "packages/parallel/package.json",
      manifest({ test: "bun test --parallel --timeout 15000" }),
      { tree },
    ),
  ).toEqual([{ root: "packages/parallel", script: "test" }]);
});

// Why: one script with both forms, or naming one root twice, must still give one suggestion per path.
test("both forms and a repeated root give one suggestion per path", async () => {
  const repository = await repositoryWith({
    [WRAPPER]: "",
    ...pkg(
      "twice",
      {
        test: `bun test ./tests ./tests/ && bun ../../${WRAPPER} ./tests ./tests`,
      },
      PRELOAD,
    ),
  });
  const { tests } = await declaredTests(repository);
  expect([...tests]).toEqual([
    [
      "packages/twice/tests/inner.test.ts",
      [
        `package-scripts-bun-test: packages/twice/package.json script "test", Bun's test-file rule`,
      ],
    ],
  ]);
});

// Why: the reader must not walk Bun's rule over the whole repository because the root's own
// bunfig.toml has a [test] table: fixtures named like tests under a folder no script names stay
// undeclared.
test("a test-named file no script's roots cover stays undeclared", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({
      test: "bun run test:root",
      // Without this repository's ignore flag, which makes a command declare nothing.
      "test:root": `bun ${WRAPPER} ./tests --timeout 60000`,
    }),
    "bunfig.toml": `[install]\nminimumReleaseAgeExcludes = ["effect"]\n\n[test]\npreload = ["./${WRAPPER}"]\n`,
    [WRAPPER]: "",
    "tests/root.test.ts": "",
    "validation/fixtures/source-evidence/utf8-fidelity.test.ts": "",
    "research/bench/semantic-boundary.test.ts": "",
  });
  const { tests } = await declaredTests(repository);
  expect([...tests.keys()]).toEqual(["tests/root.test.ts"]);
});

// Why: a bunfig.toml that cannot be read must be disclosed, and since it may narrow what Bun runs,
// the manifest beside it declares nothing in either form.
test("an unreadable bunfig.toml is a disclosed gap and declares nothing", async () => {
  const repository = await repositoryWith({
    [WRAPPER]: "",
    ...pkg("lost", { test: `bun ../../${WRAPPER} ./tests` }, PRELOAD),
    ...pkg("lostform", { test: "bun test ./tests" }, `${PRELOAD}# form\n`),
  });
  const bunfigs = repository.tree.filter((entry) =>
    entry.path.endsWith("/bunfig.toml"),
  );
  expect(bunfigs.length).toBe(2);
  for (const bunfig of bunfigs)
    rmSync(
      join(
        repository.root,
        ".git",
        "objects",
        bunfig.oid.slice(0, 2),
        bunfig.oid.slice(2),
      ),
    );
  const { tests, gaps } = await declaredTests({
    ...repository,
    paths: repository.paths.filter((path) => !path.endsWith("/bunfig.toml")),
  });
  expect(tests.size).toBe(0);
  expect(gaps).toEqual([
    ...DECLARATION_GAPS,
    "package-scripts-bun-test: 2 bunfig.toml file(s) could not be read; the test wrappers they name were not checked",
  ]);
});

// Why: Bun's TOML parser is synchronous and quadratic, so a bunfig.toml over the cap must not be
// parsed: it names nothing, even with a valid preload, the manifest beside it declares nothing in
// either form, and it is disclosed per directory.
test("a bunfig.toml over 64 KiB names nothing and is a disclosed gap", async () => {
  const oversized = `${PRELOAD}${"# padding\n".repeat(6_600)}`;
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(65_536);
  const script = { test: `bun ../../${WRAPPER} ./tests` };
  const repository = await repositoryWith({
    [WRAPPER]: "",
    ...pkg("big", script, oversized),
    ...pkg("bigtoo", script, oversized),
    // The `bun test` form beside an over-cap file declares nothing either.
    ...pkg("bigform", { test: "bun test ./tests" }, oversized),
    ...pkg("small", script, PRELOAD),
  });
  const { tests, gaps } = await declaredTests(repository);
  expect([...tests.keys()]).toEqual(inner("small"));
  expect(gaps).toEqual([
    ...DECLARATION_GAPS,
    "package-scripts-bun-test: 3 bunfig.toml file(s) over 64 KiB were not read; the test wrappers they name were not checked",
  ]);
});

// Why: a script word that names a submodule link, or a path under one, is a root that holds nothing
// in this tree; it must not fall back to the package's directory and declare its fixtures.
test("a submodule link named by a script declares nothing", async () => {
  const repository = await repositoryWith(
    {
      [WRAPPER]: "",
      "package.json": manifest({ test: "bun test ./vendor/lib" }),
      "validation/fixtures/a.test.ts": "",
      "src/b.test.ts": "",
      ...pkg("under", { test: "bun test ./vendor/lib/tests" }),
      ...pkg("wrapped", { test: `bun ../../${WRAPPER} ./vendor/lib` }, PRELOAD),
      // After a flag the link must still count as named, or the package would be the root.
      ...pkg("flagged", { test: "bun test --bail ./vendor/lib" }),
      ...pkg("flaggedunder", { test: "bun test --bail ./vendor/lib/tests" }),
      // The directory above a link is a directory: a root that holds nothing here.
      ...pkg("abovelink", { test: "bun test --bail ./vendor" }),
      ...pkg("control", { test: "bun test ./tests" }),
    },
    {
      links: [
        "vendor/lib",
        "packages/under/vendor/lib",
        "packages/wrapped/vendor/lib",
        "packages/flagged/vendor/lib",
        "packages/flaggedunder/vendor/lib",
        "packages/abovelink/vendor/lib",
      ],
    },
  );
  expect(
    repository.tree.filter((entry) => entry.type === "commit").length,
  ).toBe(6);
  const { tests } = await declaredTests(repository);
  expect([...tests.keys()]).toEqual(inner("control"));
  expect(
    bunTestRoots("package.json", manifest({ test: "bun test ./vendor/lib" }), {
      tree: treePathsOf(repository.tree),
    }),
  ).toEqual([]);
  expect(
    bunTestRoots(
      "packages/abovelink/package.json",
      manifest({ test: "bun test ./vendor" }),
      { tree: treePathsOf(repository.tree) },
    ),
  ).toEqual([{ root: "packages/abovelink/vendor", script: "test" }]);
});

// Why: the tree lookups keep no memory per directory; on many entries that share one deep chain of
// directories they must still tell a file, a directory, a missing path, a link and a path under a
// link apart. The structure is the fix; no memory or time is asserted.
test("tree lookups are right over many entries sharing one deep chain", async () => {
  const repository = await repositoryWith({ "package.json": "{}" });
  const git = (args: string[], input: string) => {
    const out = Bun.spawnSync(["git", "-C", repository.root, ...args], {
      env,
      stdin: Buffer.from(input),
    });
    if (out.exitCode !== 0) throw new Error("Fixture Git failed");
    return out.stdout.toString().trim();
  };
  const empty = git(["hash-object", "-w", "--stdin"], "");
  const scripts = git(
    ["hash-object", "-w", "--stdin"],
    manifest({ test: "bun test ./t5" }),
  );
  let chain = git(["mktree"], `100644 blob ${empty}\tx.test.ts\n`);
  for (let level = 0; level < 300; level++)
    chain = git(["mktree"], `040000 tree ${chain}\ta\n`);
  const top = git(
    ["mktree"],
    [
      ...Array.from({ length: 300 }, (_, i) => `040000 tree ${chain}\tt${i}\n`),
      `100644 blob ${scripts}\tpackage.json\n`,
      `160000 commit ${"1".repeat(40)}\tvendor\n`,
    ].join(""),
  );
  const tree = await Effect.runPromise(lsTree(repository.root, top));
  expect(tree.length).toBe(302);
  const deep = `t5/${"a/".repeat(300)}x.test.ts`;
  const lookups = treePathsOf(tree);
  expect(lookups.kindOf(deep)).toBe("file");
  expect(lookups.kindOf(`t5/${"a/".repeat(150)}a`)).toBe("directory");
  expect(lookups.kindOf("t299")).toBe("directory");
  expect(lookups.kindOf("t5/b")).toBeUndefined();
  expect(lookups.kindOf("vendor")).toBe("link");
  expect(lookups.kindOf("vendor/x/y")).toBe("link");
  // Two of the paths are asked: Git's own attribute check is slow on deep paths, and that
  // reader is not this one.
  const { tests } = await declaredTests({
    root: repository.root,
    revision: top,
    tree,
    paths: [deep, deep.replace("t5/", "t6/")],
  });
  expect([...tests.keys()]).toEqual([deep]);
  // Building the chain takes one Git process per level.
}, 60_000);

// Why: the binary search must find a directory whose name is a prefix of a sibling's, the first
// and last entries, and nothing in an empty tree.
test("tree lookups at the edges of the sorted paths", () => {
  const entry = (path: string, type = "blob"): TreeEntry => ({
    mode: type === "blob" ? "100644" : "160000",
    type,
    oid: "1".repeat(40),
    size: type === "blob" ? 0 : null,
    path,
  });
  const lookups = treePathsOf([
    entry("a/x"),
    entry("a-b/y"),
    entry("a.txt"),
    entry("ab/z"),
    entry("m/lib", "commit"),
  ]);
  const kinds = Object.fromEntries(
    [
      "a",
      "a-b",
      "a.txt",
      "ab",
      "a/x",
      "a-b/y",
      "ab/z",
      "m",
      "m/lib",
      "m/lib/q",
      "a-",
      "aa",
      "a/y",
      "b",
      "m/li",
      "a.txt/q",
      "",
    ].map((path) => [path, lookups.kindOf(path) ?? null]),
  );
  expect(kinds).toEqual({
    a: "directory",
    "a-b": "directory",
    "a.txt": "file",
    ab: "directory",
    "a/x": "file",
    "a-b/y": "file",
    "ab/z": "file",
    m: "directory",
    "m/lib": "link",
    "m/lib/q": "link",
    "a-": null,
    aa: null,
    "a/y": null,
    b: null,
    "m/li": null,
    "a.txt/q": null,
    "": "directory",
  });
  const none = treePathsOf([]);
  expect(none.kindOf("")).toBe("directory");
  expect(none.kindOf("a")).toBeUndefined();
});

// Why: a manifest's words are read once per directory that holds it, so a call stops reading
// manifests past its word budget and discloses how many it left unread.
test("past the word budget the remaining manifests declare nothing", async () => {
  const repository = await repositoryWith({
    ...pkg("a", { test: "bun test ./tests" }),
    ...pkg("b", { test: "bun test ./tests" }),
  });
  const within = await declaredTests({ ...repository, wordBudget: 6 });
  expect([...within.tests.keys()].sort()).toEqual([
    ...inner("a"),
    ...inner("b"),
  ]);
  expect(within.gaps).toEqual(DECLARATION_GAPS);
  const past = await declaredTests({ ...repository, wordBudget: 4 });
  expect([...past.tests.keys()]).toEqual(inner("a"));
  expect(past.gaps).toEqual([
    ...DECLARATION_GAPS,
    "package-scripts-bun-test: 1 package manifest(s) were not read: the budget of 4 script words per call was spent; their test roots were not checked",
  ]);
});

// Why: Bun's discovery skips hidden directories and `node_modules` below its root, and a
// `--path-ignore-patterns` flag or a `[test]` table's `root` or `pathIgnorePatterns` changes what it
// runs. The reader applies the first and refuses the others, so it never declares a file Bun skips.
test("Bun's own exclusions are applied or declare nothing", async () => {
  const layout = [
    "tests/a.test.ts",
    "fixtures/b.test.ts",
    "src/c.test.ts",
    "top.test.ts",
    ".hidden/h.test.ts",
    "src/.inner/i.test.ts",
    "node_modules/x/n.test.ts",
  ];
  const wrapper = `bun ../../${WRAPPER} ./tests`;
  const packages: Record<string, { script: string; bunfig?: string }> = {
    bare: { script: "bun test" },
    src: { script: "bun test ./src" },
    ignored: {
      script:
        "bun test ./tests ./fixtures --path-ignore-patterns='fixtures/**'",
    },
    root: { script: "bun test", bunfig: '[test]\nroot = "./tests"\n' },
    patterns: {
      script: "bun test",
      bunfig: '[test]\npathIgnorePatterns = ["fixtures/**"]\n',
    },
    oddpreload: {
      script: "bun test",
      bunfig: '[test]\nroot = "./tests"\npreload = 1\n',
    },
    wrapped: { script: wrapper, bunfig: PRELOAD },
    wrappedroot: {
      script: wrapper,
      bunfig: `${PRELOAD}root = "./tests"\n`,
    },
    wrappedpatterns: {
      script: wrapper,
      bunfig: `${PRELOAD}pathIgnorePatterns = ["fixtures/**"]\n`,
    },
  };
  const files: Record<string, string> = { [WRAPPER]: "" };
  for (const [name, { script, bunfig }] of Object.entries(packages)) {
    files[`packages/${name}/package.json`] = manifest({ test: script });
    if (bunfig !== undefined) files[`packages/${name}/bunfig.toml`] = bunfig;
    for (const path of layout) files[`packages/${name}/${path}`] = "";
  }
  const repository = await repositoryWith(files);
  const { tests } = await declaredTests(repository);
  const declared = (name: string) =>
    [...tests.keys()]
      .filter((path) => path.startsWith(`packages/${name}/`))
      .map((path) => path.slice(`packages/${name}/`.length))
      .sort();
  expect(declared("bare")).toEqual([
    "fixtures/b.test.ts",
    "src/c.test.ts",
    "tests/a.test.ts",
    "top.test.ts",
  ]);
  expect(declared("src")).toEqual(["src/c.test.ts"]);
  expect(declared("wrapped")).toEqual(["tests/a.test.ts"]);
  for (const name of [
    "ignored",
    "root",
    "patterns",
    "oddpreload",
    "wrappedroot",
    "wrappedpatterns",
  ])
    expect({ name, declared: declared(name) }).toEqual({ name, declared: [] });
});

// Why: repository data must not cost time that grows faster than its bytes: a script word half a
// million components deep, read as one blob in three directories, and a tree entry 64,000 levels
// deep. The suite's per-test timeout is the bound; no time is asserted.
test("hostile sizes declare nothing and stay linear", async () => {
  // Written as a path (`./`): a plain word is a filter, which Bun never resolves (round 12c).
  const deepWord = `./${"a/".repeat(519_998)}a`;
  const deepManifest = manifest({ test: `bun test ${deepWord}` });
  expect(Buffer.byteLength(deepManifest)).toBeLessThanOrEqual(1_048_576);
  const repository = await repositoryWith({
    ...pkg("deep1", {}),
    ...pkg("deep2", {}),
    ...pkg("deep3", {}),
    "packages/deep1/package.json": deepManifest,
    "packages/deep2/package.json": deepManifest,
    "packages/deep3/package.json": deepManifest,
  });
  const top = repository.tree.find(
    (entry) => entry.path === "packages/deep1/top.test.ts",
  );
  if (top === undefined) throw new Error("Expected a test file");
  const deepPath = `${"d/".repeat(64_000)}x.test.ts`;
  const tree = [...repository.tree, { ...top, path: deepPath }];
  // The deep path is in the tree, not among the paths asked: Git's own attribute check is slow
  // on it, and that reader is not this one.
  const { tests } = await declaredTests({ ...repository, tree });
  expect(tests.size).toBe(0);
  // The deep entry takes no part in the tree, and a word naming it is not confirmed.
  expect(
    bunTestRoots("package.json", manifest({ test: `bun test ./${deepPath}` }), {
      tree: treePathsOf(tree),
    }),
  ).toEqual([]);
});

// Why: a hostile [test].preload must name nothing without throwing; a legitimate one that climbs
// to a sibling directory inside the repository must still resolve.
test("bunfig preloads keep only paths inside the repository", () => {
  const at = "packages/harness/bunfig.toml";
  expect(bunfigTestPreloads(at, PRELOAD)).toEqual([WRAPPER]);
  expect(bunfigTestPreloads(at, `[test]\npreload = "./setup.ts"\n`)).toEqual([
    "packages/harness/setup.ts",
  ]);
  for (const text of [
    deepToml,
    `[test]\npreload = ${hostileList}\n`,
    `[test]\npreload = ["../../${WRAPPER}", 1]\n`,
    "[test]\npreload = 1\n",
    "[test]\npreload = { a = 1 }\n",
    '[test\npreload = "',
  ])
    expect(bunfigTestPreloads(at, text)).toEqual([]);
  expect(
    bunfigTestPreloads(
      at,
      `[test]\npreload = ["/${WRAPPER}", "../../../${WRAPPER}", "a\\u0000b", ""]\n`,
    ),
  ).toEqual([]);
});

const PINNED = "ef21511e71f1f557d0895f9c71c04132e223efe9";
const enclosing = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
  cwd: import.meta.dir,
});
const repository = enclosing.stdout.toString().trim();
const pinnedPresent =
  enclosing.exitCode === 0 &&
  Bun.spawnSync([
    "git",
    "-C",
    repository,
    "cat-file",
    "-e",
    `${PINNED}^{commit}`,
  ]).exitCode === 0;

// Why: this repository is the case the change was built for; its counts at a commit on main for
// good show both parts work on real scripts and that its fixtures named like tests stay undeclared.
test.skipIf(!pinnedPresent)(
  "this repository at a pinned commit declares its test roots and not its fixtures",
  async () => {
    const tree = await Effect.runPromise(lsTree(repository, PINNED));
    const named = tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          BUN_TEST_FILE.test(entry.path.split("/").at(-1) ?? ""),
      )
      .map((entry) => entry.path);
    const declared = async (entries: ReadonlyArray<TreeEntry>) => {
      const { tests } = await declaredTests({
        root: repository,
        revision: PINNED,
        tree: entries,
        paths: named,
      });
      return named.filter((path) => tests.has(path));
    };
    const scriptForm = await declared(
      tree.filter((entry) => !entry.path.split("/").includes("bunfig.toml")),
    );
    const withWrapper = await declared(tree);
    expect(named.length).toBe(714);
    expect(scriptForm.length).toBe(175);
    // 692, not 710: the root `test:root` script passes `--path-ignore-patterns`, which the reader
    // does not apply, so it declares nothing and the root `tests/` files outside `tests/release/`
    // (declared there by `test:release`) are not declared.
    expect(withWrapper.length).toBe(692);
    const undeclared = named.filter((path) => !withWrapper.includes(path));
    expect(undeclared.filter((path) => !path.startsWith("tests/"))).toEqual([
      "research/pr-bench/embedding-rd/semantic-boundary.test.ts",
      "validation/fixtures/source-evidence/qualified-git-blob.test.ts",
      "validation/fixtures/source-evidence/qualified-listing-controls.test.ts",
      "validation/fixtures/source-evidence/utf8-fidelity.test.ts",
    ]);
  },
  60_000,
);

// Why: the same input now gives another output, so every key that depends on declarations must move.
test("the declarations recipe moved and the index recipe carries it", () => {
  expect(DECLARATIONS_RECIPE).toBe("neuve-declarations-v4");
  expect(indexRecipe(captureOutlineSource()).declarations).toBe(
    "neuve-declarations-v4",
  );
});
