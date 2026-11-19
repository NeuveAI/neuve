// A caller row lifts the missing-caller gap only when a declaration the reader followed says its
// file is not a test, so every place the reader gives up must leave the files it would have settled
// undecided, with a `by` naming that place, and a name may only withhold, never make a test. These
// tests pin each place, the runners' conventions, the marker switch, and this repository's counts.
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
  BUN_NAMED_BY,
  BUN_TEST_FILE,
  DECLARATION_GAPS,
  NOT_ASKED_BY,
  RUNNER_CONFIGS,
  TEST_CONVENTIONS,
  TEST_CONVENTIONS_RECIPE,
  kindsOf,
  readDeclarations,
  testStatusOf,
  type ReadDeclarations,
} from "../src/declarations.ts";
import { lsTree, type TreeEntry } from "../src/git-objects.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A scratch repository with one commit of `files` and symbolic links, its tree and its paths. */
const repositoryWith = async (
  files: Record<string, string>,
  symlinks: Record<string, string> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "declarations-undecided-"));
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
  for (const [path, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  git("add", ".");
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
  /** Removes a blob's object, so the reader cannot read it. */
  const lose = (path: string) => {
    const oid = tree.find((entry) => entry.path === path)?.oid;
    if (oid === undefined) throw new Error("Expected a blob");
    rmSync(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  };
  return { root, revision, tree, paths: tree.map((entry) => entry.path), lose };
};

const read = (
  repository: {
    root: string;
    revision: string;
    tree: ReadonlyArray<TreeEntry>;
    paths: ReadonlyArray<string>;
  },
  extra: { wordBudget?: number; markers?: false } = {},
): Promise<ReadDeclarations> =>
  Effect.runPromise(
    readDeclarations({
      repository: repository.root,
      revision: repository.revision,
      tree: repository.tree,
      paths: repository.paths,
      ...extra,
    }),
  );

const statusOf = (declarations: ReadDeclarations, path: string) => {
  const status = testStatusOf(declarations, path);
  return typeof status === "string" ? status : status.undecided;
};

const manifest = (scripts: Record<string, unknown>, name?: string) =>
  JSON.stringify(name === undefined ? { scripts } : { name, scripts });
const script = (name: string, rest: string) =>
  `package-scripts-bun-test: packages/${name}/package.json script "test" ${rest}`;
const bunfigBy = (name: string, which: string) =>
  script(
    name,
    `runs Bun's test runner beside packages/${name}/bunfig.toml, which ${which}, so the reader does not follow it`,
  );
const whole = (name: string, rest: string) =>
  `package-scripts-bun-test: packages/${name}/package.json ${rest}`;

/** The closing rule's `by`: `bun` with an unresolvable word where the reader does not follow. */
const closing = (name: string) =>
  `script-paths: packages/${name}/package.json script "test" runs bun with a word the reader cannot resolve to a path, where it does not follow the script, so any file in the package may be one it runs`;

/** A manifest that was not read may hold a runner's configuration, which covers its package. */
const unreadConfig = (name: string) =>
  `runner-configs: packages/${name}/package.json was not read, so the jest, ava or mocha configuration it may hold is not known`;

// One package per place the reader gives up. `top_test.ts` is named for Bun's rule and for no other
// runner's convention, so the place names its `by`.
const places: ReadonlyArray<{
  name: string;
  manifest?: string;
  bunfig?: string;
  bunfigLink?: string;
  manifestLink?: string;
  /** The object of this file under the package is removed after the commit. */
  lose?: string;
  extra?: Record<string, string>;
  by: string;
  /** What `src/plain.ts` reads when it is not `not-test`. */
  plain?: string;
}> = [
  {
    name: "unparsed",
    manifest: manifest({ test: "bun test './tests" }),
    by: script("unparsed", "uses shell syntax the reader does not parse"),
    // `bun` where the reader does not follow the script reaches its package (round 12g).
    plain: closing("unparsed"),
  },
  {
    name: "opaquehead",
    manifest: manifest({ test: "$RUN test" }),
    by: script(
      "opaquehead",
      "has a command word the shell would change, which the reader does not follow",
    ),
    // The command may be anything given any file of the package (round 12e).
    plain:
      'script-paths: packages/opaquehead/package.json script "test" runs a command word the shell would change, so any file in the package may be one it names',
  },
  {
    name: "reserved",
    manifest: manifest({ test: "if true; then bun test; fi" }),
    by: script("reserved", `runs "if", which the reader does not follow`),
    // `bun` where the reader does not follow the script reaches its package (round 12g).
    plain: closing("reserved"),
  },
  {
    name: "envoption",
    manifest: manifest({ test: "env -C tests bun test" }),
    by: script(
      "envoption",
      "runs env with an option, which the reader does not follow",
    ),
  },
  {
    name: "cd",
    manifest: manifest({ test: "cd tests && bun test" }),
    by: script(
      "cd",
      `changes directory with "cd", and the reader does not follow the commands from there on`,
    ),
    // `bun` where the reader does not follow the script reaches its package (round 12g).
    plain: closing("cd"),
  },
  {
    name: "pushd",
    manifest: manifest({ test: "pushd tests; bun test" }),
    by: script(
      "pushd",
      `changes directory with "pushd", and the reader does not follow the commands from there on`,
    ),
    // `bun` where the reader does not follow the script reaches its package (round 12g).
    plain: closing("pushd"),
  },
  {
    name: "opaquebun",
    manifest: manifest({ test: "bun $MODE ./tests" }),
    by: script(
      "opaquebun",
      "passes bun a word the shell would change, which the reader does not follow",
    ),
    // The word may become any file in the package (round 12d).
    plain: script(
      "opaquebun",
      "passes bun a word the shell would change, which the reader does not follow",
    ),
  },
  {
    name: "cwd",
    manifest: manifest({ test: "bun test --cwd tests" }),
    by: script("cwd", "uses --cwd, which the reader does not follow"),
  },
  {
    name: "ignore",
    manifest: manifest({ test: "bun test ./tests --path-ignore-patterns=x" }),
    by: script(
      "ignore",
      "uses --path-ignore-patterns, which the reader does not follow",
    ),
  },
  {
    name: "opaquearg",
    manifest: manifest({ test: "bun test $FILES" }),
    by: script(
      "opaquearg",
      "passes Bun's test runner a word the shell would change, which the reader does not follow",
    ),
    // The word may become any file in the package (round 12d).
    plain: script(
      "opaquearg",
      "passes Bun's test runner a word the shell would change, which the reader does not follow",
    ),
  },
  {
    name: "unconfirmed",
    // A path word (`./`): a plain word is a filter, not a path the tree must confirm.
    manifest: manifest({ test: "bun test ./integration" }),
    by: script(
      "unconfirmed",
      "passes Bun's test runner a word that is not a path in the tree, which the reader does not follow",
    ),
  },
  {
    name: "bunfigroot",
    bunfig: '[test]\nroot = "./tests"\n',
    by: bunfigBy("bunfigroot", "sets [test].root"),
  },
  {
    name: "bunfigignore",
    bunfig: '[test]\npathIgnorePatterns = ["x/**"]\n',
    by: bunfigBy("bunfigignore", "sets [test].pathIgnorePatterns"),
  },
  {
    name: "bunfigbig",
    bunfig: `[test]\n${"# padding\n".repeat(6_600)}`,
    by: bunfigBy("bunfigbig", "is over 64 KiB and was not read"),
  },
  {
    name: "bunfigtoml",
    bunfig: '[test\nroot = "',
    by: bunfigBy("bunfigtoml", "is not valid TOML"),
  },
  {
    name: "bunfigvalue",
    bunfig: "test = 1\n",
    by: bunfigBy("bunfigvalue", "has a test value that is not a table"),
  },
  {
    name: "bunfiglost",
    bunfig: "# lost\n[test]\n",
    lose: "bunfig.toml",
    by: bunfigBy("bunfiglost", "could not be read"),
  },
  {
    name: "bunfiglink",
    manifest: manifest({ test: "bun ./setup.ts ./tests" }),
    bunfigLink: '[test]\npreload = ["./setup.ts"]',
    extra: { "setup.ts": "" },
    by: script(
      "bunfiglink",
      "runs bun with a file beside packages/bunfiglink/bunfig.toml, which is a symbolic link the reader does not follow, so the reader cannot tell whether that file is a test wrapper",
    ),
  },
  {
    name: "json",
    manifest: '{"scripts": ',
    by: whole("json", "is not valid JSON, so its scripts were not read"),
    // A manifest the reader cannot read reaches its own package (round 12g).
    plain: whole("json", "is not valid JSON, so its scripts were not read"),
  },
  {
    name: "scripts",
    manifest: '{"scripts": {"test": 1}}',
    by: whole(
      "scripts",
      "is not an object whose scripts are all strings, so its scripts were not read",
    ),
  },
  {
    name: "big",
    manifest: JSON.stringify({
      scripts: { test: "bun test" },
      padding: "x".repeat(1_100_000),
    }),
    by: whole("big", "is over 1024 KiB, so its scripts were not read"),
    plain: unreadConfig("big"),
  },
  {
    name: "lost",
    manifest: manifest({ test: "bun test" }, "lost"),
    lose: "package.json",
    by: whole("lost", "could not be read, so its scripts were not read"),
    plain: unreadConfig("lost"),
  },
  {
    name: "link",
    manifestLink: "../real/package.json",
    by: whole(
      "link",
      "is a symbolic link the reader does not follow, so its scripts were not read",
    ),
    plain: unreadConfig("link"),
  },
  {
    name: "bunflag",
    manifest: manifest({ test: "bun --silent test" }),
    by: script(
      "bunflag",
      "passes bun a flag before its command, which the reader does not follow",
    ),
  },
  {
    name: "buncwd",
    manifest: manifest({ test: "bun --cwd .. test" }),
    by: script("buncwd", "uses --cwd, which the reader does not follow"),
  },
  // A word the tree cannot confirm may name a place outside the package; no `packages/sibling`.
  {
    name: "climb",
    manifest: manifest({ test: "bun test ../sibling/tests" }),
    by: script(
      "climb",
      "passes Bun's test runner a word that is not a path in the tree, which the reader does not follow",
    ),
  },
  // The ignore flag does not end the reading: the unconfirmed word after it still counts.
  {
    name: "ignoreclimb",
    manifest: manifest({
      test: "bun test --path-ignore-patterns=x ./missing/../../other",
    }),
    by: script(
      "ignoreclimb",
      "passes Bun's test runner a word that is not a path in the tree, which the reader does not follow",
    ),
  },
];

/**
 * The places that only narrow inside the roots the script names, so the run stays in the
 * manifest's directory and only test-named files there are undecided. At every other place where
 * the run goes is not known, so the whole repository is.
 */
const DIRECTORY_SCOPED = new Set([
  "ignore",
  "bunfigroot",
  "bunfigignore",
  "bunfigbig",
  "bunfigtoml",
  "bunfigvalue",
  "bunfiglost",
  "bunfiglink",
]);

/**
 * The places whose words may name any file in the package the script runs in (round 12d): they
 * reach that package's files, so a test-named file outside it is left to Bun's rule.
 */
const PACKAGE_SCOPED = new Set(["opaquebun", "opaquearg"]);

/** The files and symbolic links of one place's package. */
const placeFiles = (
  place: (typeof places)[number],
  files: Record<string, string>,
  symlinks: Record<string, string>,
) => {
  const at = `packages/${place.name}`;
  if (place.manifestLink !== undefined)
    symlinks[`${at}/package.json`] = place.manifestLink;
  else
    files[`${at}/package.json`] =
      place.manifest ?? manifest({ test: "bun test" }, place.name);
  if (place.bunfig !== undefined) files[`${at}/bunfig.toml`] = place.bunfig;
  if (place.bunfigLink !== undefined)
    symlinks[`${at}/bunfig.toml`] = place.bunfigLink;
  for (const [path, body] of Object.entries(place.extra ?? {}))
    files[`${at}/${path}`] = body;
  files[`${at}/top_test.ts`] = "";
  files[`${at}/tests/inner.test.ts`] = "";
  files[`${at}/src/plain.ts`] = "";
};

// Why: each place the reader gives up must name the test-named file under its manifest with its
// own `by`, while a file another followed script declares stays a test and a file not named as a
// test stays not-test unless a manifest the reader did not read (which may hold a runner's
// configuration) covers it; a change of directory that runs nothing after it, or a script the
// reader follows, gives no place of its own.
test("every place the reader gives up leaves its test-named files undecided", async () => {
  const files: Record<string, string> = {
    // Followed, from the repository's root: it declares each package's `tests/` folder (written as
    // paths: a plain word is a filter, which would make the whole repository its root).
    "package.json": manifest({
      test: `bun test ${[...places.map((place) => place.name), "followed"]
        .map((name) => `./packages/${name}/tests`)
        .join(" ")}`,
    }),
    "packages/real/package.json": manifest({ test: "echo real" }),
    "packages/followed/package.json": manifest({
      test: "bun test ./tests && cd x",
      lint: "echo lint",
    }),
    "packages/followed/top_test.ts": "",
    "packages/followed/tests/inner.test.ts": "",
    "packages/followed/src/plain.ts": "",
  };
  const symlinks: Record<string, string> = {};
  for (const place of places) placeFiles(place, files, symlinks);
  const repository = await repositoryWith(files, symlinks);
  for (const place of places)
    if (place.lose !== undefined)
      repository.lose(`packages/${place.name}/${place.lose}`);
  const declarations = await read(repository);
  for (const place of places) {
    const at = `packages/${place.name}`;
    expect({
      name: place.name,
      top: statusOf(declarations, `${at}/top_test.ts`),
      inner: statusOf(declarations, `${at}/tests/inner.test.ts`),
      plain: statusOf(declarations, `${at}/src/plain.ts`),
    }).toEqual({
      name: place.name,
      top: place.by,
      inner: "test",
      plain: place.plain ?? "not-test",
    });
    expect(kindsOf(declarations, `${at}/top_test.ts`)).toBe("undeclared");
  }
  expect(new Set(places.map((place) => place.by)).size).toBe(places.length);
  // The followed package has no place of its own; its test-named file is reached only by the
  // earliest place whose run may go anywhere (an oversized manifest is noted before the others).
  expect(statusOf(declarations, "packages/followed/top_test.ts")).toBe(
    places.find((place) => place.name === "big")?.by ?? "",
  );
  expect(statusOf(declarations, "packages/followed/tests/inner.test.ts")).toBe(
    "test",
  );
  expect(statusOf(declarations, "packages/followed/src/plain.ts")).toBe(
    "not-test",
  );
  // Nothing else is undecided: each place's `top_test.ts`, the followed package's, the other
  // files under the manifests that were not read (the plain file and the manifest itself), and
  // the wrapper file a script names (round 12e: a named path is undecided).
  expect([...declarations.undecided.keys()].sort()).toEqual(
    [
      ...places.map((place) => `packages/${place.name}/top_test.ts`),
      "packages/followed/top_test.ts",
      "packages/bunfiglink/setup.ts",
      ...places
        .filter((place) => place.plain !== undefined)
        .flatMap((place) => [
          `packages/${place.name}/src/plain.ts`,
          `packages/${place.name}/package.json`,
        ]),
    ].sort(),
  );
});

// Why: a test-named file outside the package is undecided whatever the place (round 12c: no place
// decides it any more); a place whose run may go anywhere names it, and one that only narrows
// inside its package, or whose words reach only its package (round 12d: the opaque words were
// whole-repository in 12c), leaves it to Bun's rule.
test("a test-named file outside the package is undecided at every place", async () => {
  for (const place of places) {
    const files: Record<string, string> = { "elsewhere/away_test.ts": "" };
    const symlinks: Record<string, string> = {};
    placeFiles(place, files, symlinks);
    if (place.manifestLink !== undefined)
      files["packages/real/package.json"] = manifest({ test: "echo real" });
    const repository = await repositoryWith(files, symlinks);
    if (place.lose !== undefined)
      repository.lose(`packages/${place.name}/${place.lose}`);
    const declarations = await read(repository);
    expect({
      name: place.name,
      away: statusOf(declarations, "elsewhere/away_test.ts"),
    }).toEqual({
      name: place.name,
      away:
        DIRECTORY_SCOPED.has(place.name) || PACKAGE_SCOPED.has(place.name)
          ? BUN_NAMED_BY
          : place.by,
    });
  }
}, 60_000);

// Why: the case the scope exists for: a nested package's `cd .. && bun test` runs Bun from the
// directory above, so a test-named file outside the package must read undecided, while a file a
// followed script declares stays a test.
test("cd .. in a nested package leaves files outside it undecided", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./lib" }),
    "lib/kept.test.ts": "",
    "packages/inner/package.json": manifest({ test: "cd .. && bun test" }),
    "packages/inner/here_test.ts": "",
    "packages/sibling/there_test.ts": "",
    "tools/top_test.ts": "",
    "tools/plain.ts": "",
  });
  const declarations = await read(repository);
  const by = `package-scripts-bun-test: packages/inner/package.json script "test" changes directory with "cd", and the reader does not follow the commands from there on`;
  expect(
    Object.fromEntries(
      [
        "lib/kept.test.ts",
        "packages/inner/here_test.ts",
        "packages/sibling/there_test.ts",
        "tools/top_test.ts",
        "tools/plain.ts",
      ].map((path) => [path, statusOf(declarations, path)]),
    ),
  ).toEqual({
    "lib/kept.test.ts": "test",
    "packages/inner/here_test.ts": by,
    "packages/sibling/there_test.ts": by,
    "tools/top_test.ts": by,
    "tools/plain.ts": "not-test",
  });
});

// Why: past the word budget a manifest is not read, so its scripts may run anywhere: test-named
// files are undecided rather than not-test, while files declared tests within the budget keep
// their answers.
test("a manifest left unread by the word budget leaves its files undecided", async () => {
  const pkg = (name: string) => ({
    [`packages/${name}/package.json`]: manifest({ test: "bun test ./tests" }),
    [`packages/${name}/top_test.ts`]: "",
    [`packages/${name}/tests/inner.test.ts`]: "",
  });
  const repository = await repositoryWith({ ...pkg("a"), ...pkg("b") });
  const declarations = await read(repository, { wordBudget: 4 });
  const by =
    "package-scripts-bun-test: packages/b/package.json was not read: the budget of 4 script words per call was spent";
  expect(
    Object.fromEntries(
      [
        "packages/a/top_test.ts",
        "packages/a/tests/inner.test.ts",
        "packages/b/top_test.ts",
        "packages/b/tests/inner.test.ts",
      ].map((path) => [path, statusOf(declarations, path)]),
    ),
  ).toEqual({
    "packages/a/top_test.ts": by,
    "packages/a/tests/inner.test.ts": "test",
    "packages/b/top_test.ts": by,
    "packages/b/tests/inner.test.ts": by,
  });
});

// Why: two places over one file must give one deterministic answer: the nearest package's first
// place in script order (round 12c: was the first in manifest order, so the root's), and a root
// manifest's places name the files no nearer package names. The opaque word reaches the rest of
// its own package too (round 12d: its manifest is now undecided).
test("the nearest package's first place names a file's undecided", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ a: "bun test --cwd x", b: "cd x && bun test" }),
    "packages/p/package.json": manifest({ test: "bun test $X" }),
    "packages/p/top_test.ts": "",
    "packages/q/top_test.ts": "",
    "top_test.ts": "",
  });
  const declarations = await read(repository);
  const root = `package-scripts-bun-test: package.json script "a" uses --cwd, which the reader does not follow`;
  // After `cd x`, `bun test` reaches the root package (round 12g's closing rule).
  const closed = `script-paths: package.json script "b" runs bun with a word the reader cannot resolve to a path, where it does not follow the script, so any file in the package may be one it runs`;
  const own = `package-scripts-bun-test: packages/p/package.json script "test" passes Bun's test runner a word the shell would change, which the reader does not follow`;
  expect([...declarations.undecided]).toEqual([
    ["package.json", closed],
    ["packages/p/package.json", own],
    ["packages/p/top_test.ts", own],
    ["packages/q/top_test.ts", root],
    ["top_test.ts", root],
  ]);
});

/** Every rule of the pinned list with a path it matches and a near miss it does not. */
const ruleExamples: Readonly<Record<string, { match: string; miss: string }>> =
  {
    "**/*.{test,spec}.?(c|m)[jt]s?(x)": {
      match: "lib/a.test.mts",
      miss: "lib/a.tests.mts",
    },
    "**/__tests__/**/*.?([mc])[jt]s?(x)": {
      match: "src/__tests__/util.cts",
      miss: "src/__test__/util.ts",
    },
    "**/?(*.)+(spec|test).?([mc])[jt]s?(x)": {
      match: "lib/spec.mts",
      miss: "lib/specs.tsx",
    },
    "**/*.test.?(c|m)js": { match: "a.test.cjs", miss: "a.test.json" },
    "**/*-test.?(c|m)js": {
      match: "scripts/login-test.cjs",
      miss: "scripts/login-tests.cjs",
    },
    "**/*_test.?(c|m)js": { match: "a_test.mjs", miss: "a_test.jsx" },
    "**/test-*.?(c|m)js": {
      match: "scripts/test-login.mjs",
      miss: "scripts/test-login.tsx",
    },
    "**/test.?(c|m)js": {
      match: "scripts/test.mjs",
      miss: "scripts/test.json",
    },
    "**/test/**/*.?(c|m)js": {
      match: "test/fixtures/setup.js",
      miss: "tests/fixtures/setup.js",
    },
    "**/*.test.?(c|m)ts": { match: "a.test.cts", miss: "a.test.tsx" },
    "**/*-test.?(c|m)ts": {
      match: "src/foo-test.ts",
      miss: "src/foo-tests.ts",
    },
    "**/*_test.?(c|m)ts": { match: "src/a_test.mts", miss: "src/a_test.tsx" },
    "**/test-*.?(c|m)ts": { match: "src/test-x.cts", miss: "src/tests-x.cts" },
    "**/test.?(c|m)ts": { match: "src/test.mts", miss: "src/test.d.tsx" },
    "**/test/**/*.?(c|m)ts": {
      match: "test/helper.ts",
      miss: "tests/helper.ts",
    },
    "test_*.py": { match: "pkg/test_api.py", miss: "pkg/tests_api.py" },
    "*_test.py": { match: "pkg/api_test.py", miss: "pkg/api_tests.py" },
    // Go ignores a file whose name starts with `_`.
    "*_test.go": { match: "cmd/serve_test.go", miss: "cmd/_serve_test.go" },
    "**/*_spec.rb": {
      match: "spec/models/user_spec.rb",
      miss: "spec/models/user-spec.rb",
    },
    "src/test/**": {
      match: "app/src/test/resources/fixture.json",
      miss: "app/src/tests/java/AppTest.java",
    },
    // AVA's and tap's defaults match the path below the package that names the runner.
    "test.{js,cjs,mjs}": { match: "test.cjs", miss: "test.json" },
    "{src,source}/test.{js,cjs,mjs}": {
      match: "source/test.mjs",
      miss: "src/test.json",
    },
    "**/__tests__/**/*.{js,cjs,mjs}": {
      match: "a/__tests__/x.js",
      miss: "a/__test__/x.js",
    },
    "**/*.spec.{js,cjs,mjs}": { match: "x.spec.cjs", miss: "x.spec.json" },
    "**/*.test.{js,cjs,mjs}": { match: "x.test.mjs", miss: "x.test.json" },
    "**/test-*.{js,cjs,mjs}": { match: "test-a.js", miss: "test-a.json" },
    "**/test/**/*.{js,cjs,mjs}": { match: "test/a.js", miss: "test/a.json" },
    "**/tests/**/*.{js,cjs,mjs}": { match: "tests/a.js", miss: "tests/a.json" },
    "{test,tests,__tests__}/** (top-level folders)": {
      match: "tests/a.ts",
      miss: "lib/tests/a.ts",
    },
    "**/*.{spec,test}.<ext>": { match: "a.spec.tsx", miss: "a.spec.md" },
    "{test,tests}.<ext> (top-level files)": {
      match: "tests.ts",
      miss: "lib/tests.ts",
    },
  };

/**
 * One case per convention entry: a path whose first matching rule is that entry's (an earlier
 * entry or Bun's rule takes many of the others), and the `by` it must read.
 */
const conventionCases: ReadonlyArray<{
  runner: string;
  match: string;
  pattern: string;
}> = [
  {
    runner: "Jest",
    match: "src/__tests__/util.cts",
    pattern: "**/__tests__/**/*.?([mc])[jt]s?(x)",
  },
  {
    runner: "Jest",
    match: "lib/spec.mts",
    pattern: "**/?(*.)+(spec|test).?([mc])[jt]s?(x)",
  },
  {
    runner: "Node's test runner",
    match: "scripts/test-login.mjs",
    pattern: "**/test-*.?(c|m)js",
  },
  {
    runner: "Node's test runner",
    match: "src/foo-test.ts",
    pattern: "**/*-test.?(c|m)ts",
  },
  {
    runner: "Node's test runner",
    match: "test/helper.ts",
    pattern: "**/test/**/*.?(c|m)ts",
  },
  { runner: "pytest", match: "pkg/test_api.py", pattern: "test_*.py" },
  { runner: "Go", match: "cmd/serve_test.go", pattern: "*_test.go" },
  {
    runner: "RSpec",
    match: "spec/models/user_spec.rb",
    pattern: "**/*_spec.rb",
  },
  {
    runner: "Maven and Gradle",
    match: "app/src/test/kotlin/FooTest.kt",
    pattern: "src/test/**",
  },
];

const conventionBy = (runner: string, pattern: string) =>
  `test-conventions: matches ${runner}'s default test files (${pattern}), a runner the reader does not read`;

// Why: every rule of the pinned list must match its documented files and not a near miss, and a
// file named by a runner's documented default, for a runner the reader does not read, must be
// undecided with that runner's convention as `by`, never a test; a near miss is not-test.
test("each runner convention withholds on its own files and not on a near miss", async () => {
  const rules = TEST_CONVENTIONS.flatMap((entry) => entry.rules);
  expect(rules.map((rule) => rule.pattern).sort()).toEqual(
    Object.keys(ruleExamples).sort(),
  );
  for (const rule of rules) {
    const example = ruleExamples[rule.pattern];
    expect({
      pattern: rule.pattern,
      match: rule.path.test(example?.match ?? ""),
    }).toEqual({
      pattern: rule.pattern,
      match: true,
    });
    expect({
      pattern: rule.pattern,
      miss: rule.path.test(example?.miss ?? ""),
    }).toEqual({
      pattern: rule.pattern,
      miss: false,
    });
  }
  const misses = Object.values(ruleExamples)
    .map((example) => example.miss)
    // These near misses are named like a Bun test, so Bun's rule withholds on them.
    .filter((path) => !BUN_TEST_FILE.test(path.split("/").at(-1) ?? ""));
  const files: Record<string, string> = {};
  for (const path of [
    ...conventionCases.map((each) => each.match),
    "lib/a.test.mts",
    ...misses,
  ])
    files[path] = "";
  const repository = await repositoryWith(files);
  const declarations = await read(repository);
  for (const { runner, match, pattern } of conventionCases) {
    expect({ match, status: statusOf(declarations, match) }).toEqual({
      match,
      status: conventionBy(runner, pattern),
    });
    expect(kindsOf(declarations, match)).toBe("undeclared");
  }
  for (const miss of misses)
    expect({ miss, status: statusOf(declarations, miss) }).toEqual({
      miss,
      status: "not-test",
    });
  // Every entry of the pinned list has a case of its own, but Vitest (every file its default
  // names is named like a Bun test, so Bun's rule names it first) and AVA and tap, which count
  // only in a package that names them (their own test, round 12e).
  expect(new Set(conventionCases.map((entry) => entry.runner))).toEqual(
    new Set(
      TEST_CONVENTIONS.filter((entry) => entry.when === undefined)
        .map((entry) => entry.runner)
        .filter((runner) => runner !== "Vitest"),
    ),
  );
  expect(statusOf(declarations, "lib/a.test.mts")).toBe(BUN_NAMED_BY);
  expect(TEST_CONVENTIONS_RECIPE).toBe("neuve-test-conventions-v3");
});

// Why: a file a followed script declares a test stays a test even when a convention also names it;
// one named like a Bun test that no followed script declares is undecided by Bun's rule (round 12c:
// was Jest's convention).
test("a declared test is never undecided by a convention", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./tests" }),
    "tests/a.test.ts": "",
    "lib/b.test.ts": "",
  });
  const declarations = await read(repository);
  expect(statusOf(declarations, "tests/a.test.ts")).toBe("test");
  expect(statusOf(declarations, "lib/b.test.ts")).toBe(BUN_NAMED_BY);
  expect(declarations.undecided.has("tests/a.test.ts")).toBe(false);
});

// Why: `markers: false` must skip the generated-marker reader entirely (no read, so a lost blob is
// no gap, and no marker suggestion) and leave every other output as it was.
test("markers false skips the generated marker and changes nothing else", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./tests" }),
    "tests/a.test.ts": "",
    "lib/b.test.ts": "",
    "gen.ts": "// @generated\n",
    "lost.ts": "// lost, unique\n",
  });
  repository.lose("lost.ts");
  const withMarkers = await read(repository);
  const without = await read(repository, { markers: false });
  expect(withMarkers.byPath.get("gen.ts")).toEqual([
    {
      kind: "generated",
      by: `generated-marker: "@generated" in its first 1024 bytes`,
    },
  ]);
  expect(withMarkers.gaps).toEqual([
    ...DECLARATION_GAPS,
    "generated-marker: 1 blob(s) could not be read; their generated markers were not checked",
  ]);
  expect(without.byPath.has("gen.ts")).toBe(false);
  expect(without.gaps).toEqual(DECLARATION_GAPS);
  const notMarker = new Map(
    [...withMarkers.byPath]
      .map(
        ([path, list]) =>
          [
            path,
            list.filter((entry) => !entry.by.startsWith("generated-marker")),
          ] as const,
      )
      .filter(([, list]) => list.length > 0),
  );
  expect([...without.byPath]).toEqual([...notMarker]);
  expect([...without.undecided]).toEqual([...withMarkers.undecided]);
  expect(without.readers).toEqual(withMarkers.readers);
});

/** The status of each path, as a record. */
const statuses = (
  declarations: ReadDeclarations,
  paths: ReadonlyArray<string>,
) =>
  Object.fromEntries(paths.map((path) => [path, statusOf(declarations, path)]));

// Why (review B1): Bun reads `bun test tests` as a filter on the paths of every test file under
// the directory it runs in (Bun 1.4.4 ran `src/unit-tests/b_test.ts` and `c_spec.tsx` too), so a
// bare word narrows nothing: every test-named file under the manifest's directory is a test.
test("a bare word after bun test is a filter, never a root", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test tests" }),
    "tests/a.test.ts": "",
    "src/unit-tests/b_test.ts": "",
    "src/unit-tests/c_spec.tsx": "",
    "packages/a/package.json": manifest({ test: "bun test src" }),
    "packages/a/lib/src-helpers/y_test.ts": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "tests/a.test.ts",
      "src/unit-tests/b_test.ts",
      "src/unit-tests/c_spec.tsx",
      "packages/a/lib/src-helpers/y_test.ts",
    ]),
  ).toEqual({
    "tests/a.test.ts": "test",
    "src/unit-tests/b_test.ts": "test",
    "src/unit-tests/c_spec.tsx": "test",
    "packages/a/lib/src-helpers/y_test.ts": "test",
  });
});

// Why (review B2): Bun runs a file named after `./` whatever its name (Bun 1.4.4 ran
// `bun test ./scripts/check.ts`), so a file root is a test, at the root and in a package.
test("an explicit file root is a test whatever its name", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./scripts/check.ts" }),
    "scripts/check.ts": "",
    "scripts/other.ts": "",
    "packages/a/package.json": manifest({ test: "bun test ./checks/smoke.ts" }),
    "packages/a/checks/smoke.ts": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "scripts/check.ts",
      "packages/a/checks/smoke.ts",
      "scripts/other.ts",
    ]),
  ).toEqual({
    "scripts/check.ts": "test",
    "packages/a/checks/smoke.ts": "test",
    "scripts/other.ts": "not-test",
  });
  expect(declarations.byPath.get("scripts/check.ts")).toEqual([
    {
      kind: "test",
      by: `package-scripts-bun-test: package.json script "test", Bun's test-file rule`,
    },
  ]);
});

// Why (review B3): `node --test` (Node 24.8.0, type stripping on by default) runs these TypeScript
// files by its documented defaults, so each is undecided, never not-test.
test("Node's TypeScript defaults are undecided", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "node --test" }),
    "test/helper.ts": "",
    "src/foo-test.ts": "",
    "src/a_test.ts": "",
    "src/test.mts": "",
    "src/test-x.cts": "",
  });
  const declarations = await read(repository);
  const node = (pattern: string) => conventionBy("Node's test runner", pattern);
  expect(
    statuses(declarations, [
      "test/helper.ts",
      "src/foo-test.ts",
      "src/a_test.ts",
      "src/test.mts",
      "src/test-x.cts",
    ]),
  ).toEqual({
    "test/helper.ts": node("**/test/**/*.?(c|m)ts"),
    "src/foo-test.ts": node("**/*-test.?(c|m)ts"),
    // Named like a Bun test first.
    "src/a_test.ts": BUN_NAMED_BY,
    // Jest's bare `test.<suffix>` comes before Node's.
    "src/test.mts": conventionBy(
      "Jest",
      "**/?(*.)+(spec|test).?([mc])[jt]s?(x)",
    ),
    "src/test-x.cts": node("**/test-*.?(c|m)ts"),
  });
});

// Why (review B4): Jest's current `testMatch` covers `.mjs`, `.cjs`, `.mts` and `.cts`, so these
// files are undecided, never not-test.
test("Jest's current defaults are undecided", async () => {
  const repository = await repositoryWith({
    "__tests__/a.mjs": "",
    "__tests__/b.cts": "",
    "src/spec.mts": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "__tests__/a.mjs",
      "__tests__/b.cts",
      "src/spec.mts",
    ]),
  ).toEqual({
    "__tests__/a.mjs": conventionBy(
      "Jest",
      "**/__tests__/**/*.?([mc])[jt]s?(x)",
    ),
    "__tests__/b.cts": conventionBy(
      "Jest",
      "**/__tests__/**/*.?([mc])[jt]s?(x)",
    ),
    "src/spec.mts": conventionBy(
      "Jest",
      "**/?(*.)+(spec|test).?([mc])[jt]s?(x)",
    ),
  });
});

// Why (review B5): Gradle's Groovy, Kotlin and Scala plugins keep their test sources under
// `src/test/` too, so every file there is undecided.
test("every Gradle test source set is undecided", async () => {
  const repository = await repositoryWith({
    "src/test/kotlin/FooTest.kt": "",
    "src/test/groovy/BarSpec.groovy": "",
    "src/test/scala/BazSuite.scala": "",
  });
  const declarations = await read(repository);
  const jvm = conventionBy("Maven and Gradle", "src/test/**");
  expect(
    statuses(declarations, [
      "src/test/kotlin/FooTest.kt",
      "src/test/groovy/BarSpec.groovy",
      "src/test/scala/BazSuite.scala",
    ]),
  ).toEqual({
    "src/test/kotlin/FooTest.kt": jvm,
    "src/test/groovy/BarSpec.groovy": jvm,
    "src/test/scala/BazSuite.scala": jvm,
  });
});

// Why (review B6): `[test] root = "../b"` makes `bun test` in `packages/a` run `packages/b/y_test.ts`
// (Bun 1.4.4), outside the manifest's directory; the file is undecided, never not-test.
test("a [test].root that leaves the package leaves its files undecided", async () => {
  const repository = await repositoryWith({
    "packages/a/package.json": manifest({ test: "bun test" }),
    "packages/a/bunfig.toml": '[test]\nroot = "../b"\n',
    "packages/a/x_test.ts": "",
    "packages/b/y_test.ts": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, ["packages/a/x_test.ts", "packages/b/y_test.ts"]),
  ).toEqual({
    "packages/a/x_test.ts": bunfigBy("a", "sets [test].root"),
    "packages/b/y_test.ts": BUN_NAMED_BY,
  });
});

// Why (Neuve's review, ignore flag): `bun test ../../shared --path-ignore-patterns=x` in
// `packages/p` runs `shared/a_test.ts` (Bun 1.4.4), outside the package; it is undecided.
test("an ignore flag with a root outside the package leaves that root undecided", async () => {
  const repository = await repositoryWith({
    "packages/p/package.json": manifest({
      test: "bun test ../../shared --path-ignore-patterns=x",
    }),
    "shared/a_test.ts": "",
    "packages/p/b_test.ts": "",
  });
  const declarations = await read(repository);
  const ignore = script(
    "p",
    "uses --path-ignore-patterns, which the reader does not follow",
  );
  expect(
    statuses(declarations, ["shared/a_test.ts", "packages/p/b_test.ts"]),
  ).toEqual({
    "shared/a_test.ts": BUN_NAMED_BY,
    "packages/p/b_test.ts": ignore,
  });
});

// Why (Neuve's review, flag then opaque word): `bun --silent $MODE` runs the test runner when
// `MODE=test` (Bun 1.4.4 ran `a_test.ts`), so the file is undecided by that place.
test("bun with a flag then an opaque word leaves its files undecided", async () => {
  for (const command of ["bun --silent $MODE", 'bun --silent "$MODE"']) {
    const repository = await repositoryWith({
      "package.json": manifest({ test: command }),
      "a_test.ts": "",
    });
    const declarations = await read(repository);
    expect({ command, status: statusOf(declarations, "a_test.ts") }).toEqual({
      command,
      status: `package-scripts-bun-test: package.json script "test" passes Bun's test runner a word the shell would change, which the reader does not follow`,
    });
  }
});

// Why (Neuve's review, symbolic-link config): Bun follows a symbolic-link `bunfig.toml` (with
// `root = "sub"` it ran only `sub/y_test.ts`), so `bun test` beside one is not followed: both files
// are undecided, not declared tests.
test("bun test beside a symbolic-link bunfig.toml is not followed", async () => {
  const repository = await repositoryWith(
    {
      "packages/c/package.json": manifest({ test: "bun test" }),
      "packages/c/x_test.ts": "",
      "packages/c/sub/y_test.ts": "",
      "configs/c.toml": '[test]\nroot = "sub"\n',
    },
    { "packages/c/bunfig.toml": "../../configs/c.toml" },
  );
  const declarations = await read(repository);
  const linked = bunfigBy("c", "is a symbolic link the reader does not follow");
  expect(
    statuses(declarations, [
      "packages/c/x_test.ts",
      "packages/c/sub/y_test.ts",
    ]),
  ).toEqual({
    "packages/c/x_test.ts": linked,
    "packages/c/sub/y_test.ts": linked,
  });
});

// Why: the answer still exists: a file outside every root, named by no convention and under no
// runner configuration, reads not-test, while a file that could be a test does not.
test("a file nothing could make a test reads not-test", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./tests", build: "tsc -b" }),
    "tests/a.test.ts": "",
    "src/caller.ts": "",
    "src/other_test.ts": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "src/caller.ts",
      "src/other_test.ts",
      "tests/a.test.ts",
    ]),
  ).toEqual({
    "src/caller.ts": "not-test",
    "src/other_test.ts": BUN_NAMED_BY,
    "tests/a.test.ts": "test",
  });
});

/** One package per runner configuration, its config files, and the `by` its `lib/a.ts` reads. */
const configCases: ReadonlyArray<{
  name: string;
  files: Record<string, string>;
  /** The configuration file the `by` names, under the package; none for a near miss. */
  by?: string;
}> = [
  {
    name: "jestcfg",
    files: { "jest.config.mjs": "" },
    by: "jest.config.mjs (Jest's jest.config.{js,ts,mjs,mts,cjs,cts,json})",
  },
  {
    name: "jestjson",
    files: { "jest.config.json": "{}" },
    by: "jest.config.json (Jest's jest.config.{js,ts,mjs,mts,cjs,cts,json})",
  },
  {
    name: "vitestcfg",
    files: { "vitest.config.mts": "" },
    by: "vitest.config.mts (Vitest's vitest.config.{ts,mts,cts,js,mjs,cjs})",
  },
  {
    name: "vitestws",
    files: { "vitest.workspace.json": "[]" },
    by: "vitest.workspace.json (Vitest's vitest.workspace.*)",
  },
  {
    name: "vite",
    files: {
      "vite.config.ts": "",
      "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    },
    by: "vite.config.ts (Vitest's vite.config.{ts,mts,cts,js,mjs,cjs}, beside a package.json that names vitest)",
  },
  {
    name: "vitescript",
    files: {
      "vite.config.ts": "",
      "package.json": manifest({ test: "vitest run" }),
    },
    by: "vite.config.ts (Vitest's vite.config.{ts,mts,cts,js,mjs,cjs}, beside a package.json that names vitest)",
  },
  // Near misses: Vite alone runs no tests.
  {
    name: "vitemiss",
    files: { "vite.config.ts": "", "package.json": manifest({ dev: "vite" }) },
  },
  { name: "vitenomanifest", files: { "vite.config.ts": "" } },
  {
    name: "playwright",
    files: { "playwright.config.ts": "" },
    by: "playwright.config.ts (Playwright's playwright.config.*)",
  },
  {
    name: "mocha",
    files: { ".mocharc.yml": "" },
    by: ".mocharc.yml (Mocha's .mocharc.{cjs,js,mjs,yaml,yml,jsonc,json})",
  },
  {
    name: "karma",
    files: { "karma.conf.js": "" },
    by: "karma.conf.js (Karma's karma.conf.{js,coffee,ts})",
  },
  {
    name: "karmadot",
    files: { ".config/karma.conf.ts": "" },
    by: ".config/karma.conf.ts (Karma's karma.conf.{js,coffee,ts})",
  },
  {
    name: "ava",
    files: { "ava.config.mjs": "" },
    by: "ava.config.mjs (AVA's ava.config.*)",
  },
  {
    name: "pytestini",
    files: { "pytest.ini": "" },
    by: "pytest.ini (pytest's pytest.toml, .pytest.toml, pytest.ini, .pytest.ini)",
  },
  {
    name: "pytesttoml",
    files: { ".pytest.toml": "" },
    by: ".pytest.toml (pytest's pytest.toml, .pytest.toml, pytest.ini, .pytest.ini)",
  },
  {
    name: "pyproject",
    files: {
      "pyproject.toml":
        '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n',
    },
    by: "pyproject.toml (pytest's pyproject.toml, tox.ini or setup.cfg that sets python_files)",
  },
  {
    name: "toxini",
    files: { "tox.ini": "[pytest]\npython_files = check_*.py\n" },
    by: "tox.ini (pytest's pyproject.toml, tox.ini or setup.cfg that sets python_files)",
  },
  {
    name: "setupcfg",
    files: { "setup.cfg": "[tool:pytest]\npython_files = check_*.py\n" },
    by: "setup.cfg (pytest's pyproject.toml, tox.ini or setup.cfg that sets python_files)",
  },
  // Near miss: a pytest section that does not set `python_files` uses the defaults.
  {
    name: "pyprojectmiss",
    files: {
      "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    },
  },
];

/** The `by` of a runner key in a package's manifest. */
const keyBy = (name: string, key: string) =>
  `runner-configs: packages/${name}/package.json holds a "${key}" key, runner configuration the reader does not read`;

// Why: a runner configuration the reader does not read can name any file as a test, so every
// path under the directory it configures that is not declared a test is undecided, by that file;
// a `vite.config.ts` without Vitest and a pytest section without `python_files` configure no
// tests, so files there stay not-test.
test("each runner configuration leaves the files it covers undecided", async () => {
  const files: Record<string, string> = {};
  for (const { name, files: own } of configCases) {
    for (const [path, body] of Object.entries(own))
      files[`packages/${name}/${path}`] = body;
    files[`packages/${name}/lib/a.ts`] = "";
  }
  for (const key of ["jest", "ava", "mocha"]) {
    files[`packages/${key}key/package.json`] = JSON.stringify({ [key]: {} });
    files[`packages/${key}key/lib/a.ts`] = "";
  }
  files["outside/lib/a.ts"] = "";
  const repository = await repositoryWith(files);
  const declarations = await read(repository);
  for (const { name, by } of configCases)
    expect({
      name,
      status: statusOf(declarations, `packages/${name}/lib/a.ts`),
    }).toEqual({
      name,
      status:
        by === undefined
          ? "not-test"
          : `runner-configs: packages/${name}/${by}, runner configuration the reader does not read`,
    });
  for (const key of ["jest", "ava", "mocha"])
    expect(statusOf(declarations, `packages/${key}key/lib/a.ts`)).toBe(
      keyBy(`${key}key`, key),
    );
  expect(statusOf(declarations, "outside/lib/a.ts")).toBe("not-test");
  // Every entry of the pinned list has a case.
  const covered = new Set(
    configCases.flatMap(({ by }) =>
      RUNNER_CONFIGS.filter(
        (config) =>
          by?.includes(`(${config.runner}'s ${config.names})`) === true,
      ),
    ),
  );
  expect(covered.size).toBe(RUNNER_CONFIGS.length);
});

// Why: a call from a test's helper or fixture is not evidence either, so a file under a test root a
// followed script names, and not itself a test, must read undecided by that root and script, while
// a file outside every root reads not-test and a test-named file under the root stays a test. The
// package's directory, the root of a bare `bun test` by default, is not named: a helper there reads
// as source unless a test folder holds it (the coordinator's ruling; round 12c had it undecided).
test("a file under a test root that is not a test is undecided", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./tests" }),
    "tests/a.test.ts": "",
    "tests/helper.ts": "",
    "tests/fixtures/data.json": "",
    "src/x.ts": "",
    "packages/p/package.json": manifest({ test: "bun test" }),
    "packages/p/lib/util.ts": "",
    "packages/p/lib/util_test.ts": "",
    "packages/p/lib/__mocks__/fs.ts": "",
    "packages/p/lib/__tests__/fixture.json": "",
    "packages/q/package.json": manifest({ test: "bun test unit" }),
    "packages/q/lib/helper.ts": "",
  });
  const declarations = await read(repository);
  const tests = `package-scripts-bun-test: under the test root tests of package.json script "test"; not itself a test file`;
  expect(
    statuses(declarations, [
      "tests/a.test.ts",
      "tests/helper.ts",
      "tests/fixtures/data.json",
      "src/x.ts",
      "packages/p/lib/util.ts",
      "packages/p/lib/util_test.ts",
      "packages/p/lib/__mocks__/fs.ts",
      "packages/p/lib/__tests__/fixture.json",
      "packages/q/lib/helper.ts",
    ]),
  ).toEqual({
    "tests/a.test.ts": "test",
    "tests/helper.ts": tests,
    "tests/fixtures/data.json": tests,
    "src/x.ts": "not-test",
    // A bare `bun test`, or only a filter word, roots the package by default: not named.
    "packages/p/lib/util.ts": "not-test",
    "packages/q/lib/helper.ts": "not-test",
    "packages/p/lib/util_test.ts": "test",
    // Jest's test folders hold tests and mocks whatever the file's name.
    "packages/p/lib/__mocks__/fs.ts":
      "test-conventions: in a test folder (jest-mocks-folder): Jest reads a manual mock from a __mocks__ folder beside the module it mocks",
    "packages/p/lib/__tests__/fixture.json":
      "test-conventions: in a test folder (jest-tests-folder): Jest's default testMatch runs the files in any __tests__ folder",
  });
});

// Why: `bun test $FILE` (or the wrapper form with an opaque positional) may run any file in the
// package the script runs in, so every path there reads undecided by that script; the package
// stops at a nested `package.json`, and a flag's opaque value written as `--flag=$X` names no file.
test("an opaque positional word reaches every file of its package", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test $FILE" }),
    "src/a.ts": "",
    "packages/w/package.json": manifest({
      test: "bun test --timeout=$T ./tests",
    }),
    "packages/w/src/b.ts": "",
    "packages/w/tests/c.test.ts": "",
  });
  const declarations = await read(repository);
  const opaque = `package-scripts-bun-test: package.json script "test" passes Bun's test runner a word the shell would change, which the reader does not follow`;
  expect(
    statuses(declarations, [
      "src/a.ts",
      "package.json",
      "packages/w/src/b.ts",
      "packages/w/tests/c.test.ts",
    ]),
  ).toEqual({
    "src/a.ts": opaque,
    "package.json": opaque,
    // The root's script reaches its own package's files, not its nested package's.
    "packages/w/src/b.ts": "not-test",
    // An opaque flag value: the command is not followed, but it names no file.
    "packages/w/tests/c.test.ts": script(
      "w",
      "passes Bun's test runner a flag value the shell would change, which the reader does not follow",
    ),
  });
});

/** The `by` of a runner command's named path, and of one that reaches its whole package. */
const commandBy = (
  name: string,
  script: string,
  runner: string,
  path: string,
) =>
  `runner-commands: packages/${name}/package.json script "${script}" runs ${runner} on ${path}, a runner the reader does not read`;
const commandWide = (name: string, runner: string, what: string) =>
  `runner-commands: packages/${name}/package.json script "test" runs ${runner} with ${what}, so any file in the package may be one of its tests`;

// Why: another runner runs the files and folders a script gives it whatever their names
// (`node --test ./checks/smoke.mjs`, `mocha scripts/a.js`, `pytest tools`), so they read
// undecided by that script; a configuration file, an opaque word or a path the tree does not
// confirm may name any file in the package; with no positional, nothing beyond the conventions.
test("a pinned runner's paths, configuration and unknown words are undecided", async () => {
  const pkg = (
    name: string,
    test: string,
    extra: Record<string, string> = {},
  ) => ({
    [`packages/${name}/package.json`]: manifest({ test }),
    [`packages/${name}/lib/other.ts`]: "",
    ...Object.fromEntries(
      Object.entries(extra).map(([path, body]) => [
        `packages/${name}/${path}`,
        body,
      ]),
    ),
  });
  const repository = await repositoryWith({
    ...pkg("node", "node --test --import tsx ./checks/smoke.mjs", {
      "checks/smoke.mjs": "",
    }),
    ...pkg("mocha", "npx mocha scripts/a.js", { "scripts/a.js": "" }),
    ...pkg("pytest", "pytest tools -k fast", { "tools/check.py": "" }),
    ...pkg("pythonm", "python -m pytest tools/check.py", {
      "tools/check.py": "",
    }),
    ...pkg("jest", "jest --config jest.e2e.js", { "jest.e2e.js": "" }),
    ...pkg("vitest", "vitest run unit"),
    ...pkg("ava", "ava $FILES"),
    ...pkg("tap", "tap --reporter=$R"),
    ...pkg("playwright", "playwright test", { "e2e/flow.ts": "" }),
    ...pkg("nodescript", "node ./scripts/build.js", { "scripts/build.js": "" }),
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "packages/node/checks/smoke.mjs",
      "packages/node/lib/other.ts",
      "packages/mocha/scripts/a.js",
      "packages/pytest/tools/check.py",
      "packages/pythonm/tools/check.py",
      "packages/jest/lib/other.ts",
      "packages/vitest/lib/other.ts",
      "packages/ava/lib/other.ts",
      "packages/tap/lib/other.ts",
      "packages/playwright/e2e/flow.ts",
      "packages/nodescript/scripts/build.js",
    ]),
  ).toEqual({
    "packages/node/checks/smoke.mjs": commandBy(
      "node",
      "test",
      "Node's test runner",
      "packages/node/checks/smoke.mjs",
    ),
    // A named path names only itself.
    "packages/node/lib/other.ts": "not-test",
    "packages/mocha/scripts/a.js": commandBy(
      "mocha",
      "test",
      "Mocha",
      "packages/mocha/scripts/a.js",
    ),
    "packages/pytest/tools/check.py": commandBy(
      "pytest",
      "test",
      "pytest",
      "packages/pytest/tools",
    ),
    "packages/pythonm/tools/check.py": commandBy(
      "pythonm",
      "test",
      "pytest",
      "packages/pythonm/tools/check.py",
    ),
    "packages/jest/lib/other.ts": commandWide(
      "jest",
      "Jest",
      "--config, a configuration the reader does not read",
    ),
    "packages/vitest/lib/other.ts": commandWide(
      "vitest",
      "Vitest",
      "a path the tree does not confirm",
    ),
    "packages/ava/lib/other.ts": commandWide(
      "ava",
      "AVA",
      "a word the shell would change",
    ),
    // A flag's opaque value names no file.
    "packages/tap/lib/other.ts": "not-test",
    // No positional: Playwright's own defaults, which its configuration would hold.
    "packages/playwright/e2e/flow.ts": "not-test",
    // `node` without `--test` runs a script, not tests, but it is not on the list of commands
    // that never run tests, so the file it names is undecided (round 12e: was not-test).
    "packages/nodescript/scripts/build.js":
      'script-paths: packages/nodescript/package.json script "test" names this path',
  });
});

// Why: a path the declarations were not read for was never looked at, so it must never read
// not-test.
test("a path that was not asked is undecided", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({ test: "bun test ./tests" }),
    "tests/a.test.ts": "",
    "src/x.ts": "",
  });
  const declarations = await Effect.runPromise(
    readDeclarations({
      repository: repository.root,
      revision: repository.revision,
      tree: repository.tree,
      paths: ["src/x.ts"],
    }),
  );
  expect(statusOf(declarations, "src/x.ts")).toBe("not-test");
  expect(statusOf(declarations, "src/elsewhere.ts")).toBe(NOT_ASKED_BY);
  expect(statusOf(declarations, "tests/a.test.ts")).toBe(NOT_ASKED_BY);
  expect([...declarations.asked]).toEqual(["src/x.ts"]);
});

/** The `by` of a path a package's script names. */
const namedBy = (name: string, script = "test") =>
  `script-paths: packages/${name}/package.json script "${script}" names this path`;

/** One package per shape: its scripts, its other files, and its `bunfig.toml` if any. */
const shapes = (
  entries: ReadonlyArray<{
    name: string;
    test: string;
    files?: Record<string, string>;
    bunfig?: string;
  }>,
) => {
  const files: Record<string, string> = {};
  for (const { name, test, files: own, bunfig } of entries) {
    files[`packages/${name}/package.json`] = manifest({ test }, name);
    files[`packages/${name}/scripts/check.ts`] = "";
    files[`packages/${name}/tests/helper.ts`] = "";
    files[`packages/${name}/src/x.ts`] = "";
    if (bunfig !== undefined) files[`packages/${name}/bunfig.toml`] = bunfig;
    for (const [path, body] of Object.entries(own ?? {}))
      files[`packages/${name}/${path}`] = body;
  }
  return files;
};

// Why (review R2-1): Bun 1.4.4 ran `scripts/check.ts` in each of these, where the reader stopped
// on the command (an ignore flag, a narrowing `bunfig.toml`, an opaque flag value, an
// unconfirmed word) and lost the path it had named; a named path is undecided whatever the
// reader follows. With the ignore flag, the helper under the named `./tests` is undecided too.
test("a path a stopped bun test command names stays undecided", async () => {
  const repository = await repositoryWith(
    {
      ...shapes([
        {
          name: "ignore",
          test: "bun test ./scripts/check.ts --path-ignore-patterns=x",
        },
        {
          name: "wrapper",
          test: "bun ./setup.ts ./scripts/check.ts --path-ignore-patterns=x",
          files: { "setup.ts": "" },
          bunfig: '[test]\npreload = ["./setup.ts"]\n',
        },
        {
          name: "narrow",
          test: "bun test ./scripts/check.ts",
          bunfig: '[test]\npathIgnorePatterns = ["x/**"]\n',
        },
        { name: "linked", test: "bun test ./scripts/check.ts" },
        { name: "value", test: "bun test --timeout=$T ./scripts/check.ts" },
        { name: "missing", test: "bun test ./missing ./scripts/check.ts" },
        {
          name: "ignoretests",
          test: "bun test ./tests --path-ignore-patterns=x",
        },
      ]),
      "configs/linked.toml": '[test]\nroot = "sub"\n',
    },
    { "packages/linked/bunfig.toml": "../../configs/linked.toml" },
  );
  const declarations = await read(repository);
  for (const name of [
    "ignore",
    "wrapper",
    "narrow",
    "linked",
    "value",
    "missing",
  ])
    expect({
      name,
      status: statusOf(declarations, `packages/${name}/scripts/check.ts`),
    }).toEqual({
      name,
      status: namedBy(name),
    });
  expect(statusOf(declarations, "packages/ignoretests/tests/helper.ts")).toBe(
    namedBy("ignoretests"),
  );
  // Nothing named the source file.
  expect(statusOf(declarations, "packages/ignore/src/x.ts")).toBe("not-test");
});

// Why (review R2-2): Mocha's `--spec=` and `--file=` take their path after `=`, Node 24.8.0 ran
// `node --test 'scripts/*.mjs'` (its own glob), a pytest node ID names its file before `::`, and
// Jest's `--testMatch`/`--testRegex`, pytest's `-o`/`--override-ini`/`--doctest-modules` change
// which files are collected: each named file is undecided, and a collecting flag reaches the
// whole package.
test("a pinned runner's flag values, globs and collecting flags are undecided", async () => {
  const repository = await repositoryWith({
    ...shapes([
      { name: "spec", test: "mocha --spec=scripts/check.ts" },
      { name: "file", test: "mocha --file=./scripts/check.ts" },
      { name: "glob", test: "node --test 'scripts/*.ts'" },
      {
        name: "nodeid",
        test: "pytest -x tools/check.py::test_a",
        files: { "tools/check.py": "" },
      },
      { name: "match", test: "jest --testMatch '**/scripts/*.ts'" },
      { name: "regex", test: "jest --testRegex=check" },
      {
        name: "override",
        test: "pytest -o python_files=checks.py",
        files: { "tools/checks.py": "" },
      },
      {
        name: "overrideeq",
        test: "pytest --override-ini=python_files=checks.py",
        files: { "tools/checks.py": "" },
      },
      {
        name: "doctest",
        test: "pytest --doctest-modules",
        files: { "pkg/mod.py": "" },
      },
    ]),
  });
  const declarations = await read(repository);
  const wide = (name: string, runner: string, flag: string) =>
    `runner-commands: packages/${name}/package.json script "test" runs ${runner} with ${flag}, which changes the files it collects, so any file in the package may be one of its tests`;
  expect(
    statuses(declarations, [
      "packages/spec/scripts/check.ts",
      "packages/spec/src/x.ts",
      "packages/file/scripts/check.ts",
      "packages/glob/scripts/check.ts",
      "packages/glob/src/x.ts",
      "packages/nodeid/tools/check.py",
      "packages/match/scripts/check.ts",
      "packages/match/src/x.ts",
      "packages/regex/src/x.ts",
      "packages/override/tools/checks.py",
      "packages/overrideeq/tools/checks.py",
      "packages/doctest/pkg/mod.py",
    ]),
  ).toEqual({
    "packages/spec/scripts/check.ts": namedBy("spec"),
    "packages/spec/src/x.ts": wide("spec", "Mocha", "--spec"),
    "packages/file/scripts/check.ts": namedBy("file"),
    "packages/glob/scripts/check.ts": namedBy("glob"),
    // The glob names only what it matches.
    "packages/glob/src/x.ts": "not-test",
    "packages/nodeid/tools/check.py": namedBy("nodeid"),
    "packages/match/scripts/check.ts": namedBy("match"),
    "packages/match/src/x.ts": wide("match", "Jest", "--testMatch"),
    "packages/regex/src/x.ts": wide("regex", "Jest", "--testRegex"),
    "packages/override/tools/checks.py": wide("override", "pytest", "-o"),
    "packages/overrideeq/tools/checks.py": wide(
      "overrideeq",
      "pytest",
      "--override-ini",
    ),
    "packages/doctest/pkg/mod.py": wide(
      "doctest",
      "pytest",
      "--doctest-modules",
    ),
  });
});

// Why (review R2-3): AVA runs `**/tests/**/*.js` by default (`defaultTestPatterns`) and tap a
// top-level `tests/` folder (its CLI page), with no positional; each counts only in a package that
// names that runner, so the same file in a package that does not stays not-test.
test("AVA's and tap's defaults are undecided where the package names them", async () => {
  const repository = await repositoryWith({
    "packages/ava/package.json": manifest({ test: "ava" }),
    "packages/ava/tests/foo.js": "",
    "packages/tap/package.json": JSON.stringify({
      devDependencies: { tap: "21" },
    }),
    "packages/tap/tests/foo.js": "",
    "packages/neither/package.json": manifest({ test: "bun test ./spec" }),
    "packages/neither/tests/foo.js": "",
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "packages/ava/tests/foo.js",
      "packages/tap/tests/foo.js",
      "packages/neither/tests/foo.js",
    ]),
  ).toEqual({
    "packages/ava/tests/foo.js":
      "test-conventions: matches AVA's default test files (**/tests/**/*.{js,cjs,mjs}) in a package that names AVA, a runner the reader does not read",
    "packages/tap/tests/foo.js":
      "test-conventions: matches tap's default test files ({test,tests,__tests__}/** (top-level folders)) in a package that names tap, a runner the reader does not read",
    "packages/neither/tests/foo.js": "not-test",
  });
});

// Why (review R2-4): Bun 1.4.4 ran `scripts/check.ts` from each of these commands the reader does
// not follow (the flagged form, `if`/`then`/`fi`, after `cd .`, with `--cwd=.`), and from a subshell
// and a chain: the path each names is undecided. An opaque word in a command the reader does not
// follow reaches the whole package, even under a pinned runner.
test("a path an unfollowed command names is undecided", async () => {
  const repository = await repositoryWith({
    ...shapes([
      { name: "flagged", test: "bun --silent test ./scripts/check.ts" },
      { name: "iffi", test: "if true; then bun test ./scripts/check.ts; fi" },
      { name: "cddot", test: "cd . && bun test ./scripts/check.ts" },
      { name: "cwd", test: "bun test --cwd=. ./scripts/check.ts" },
      { name: "subshell", test: "(bun test ./scripts/check.ts)" },
      {
        name: "chain",
        test: "true && bun test ./scripts/check.ts || false; echo done",
      },
      { name: "cdthere", test: "cd scripts && bun test ./check.ts" },
      { name: "opaqueif", test: "if true; then node --test $F; fi" },
      { name: "cdopaque", test: "cd $DIR && bun test" },
    ]),
  });
  const declarations = await read(repository);
  for (const name of ["flagged", "iffi", "cddot", "cwd", "subshell", "cdthere"])
    expect({
      name,
      status: statusOf(declarations, `packages/${name}/scripts/check.ts`),
    }).toEqual({
      name,
      status: namedBy(name),
    });
  // A chain the reader follows: the file root is a test.
  expect(statusOf(declarations, "packages/chain/scripts/check.ts")).toBe(
    "test",
  );
  expect(statusOf(declarations, "packages/opaqueif/src/x.ts")).toBe(
    `script-paths: packages/opaqueif/package.json script "test" runs node with a word the reader cannot resolve to a path, where it does not follow the script, so any file in the package may be one it runs`,
  );
  expect(statusOf(declarations, "packages/cdopaque/src/x.ts")).toBe(
    `script-paths: packages/cdopaque/package.json script "test" changes directory to a place the reader cannot tell, so any file in the package may be one it names`,
  );
});

// Why (review R2-5): one hostile script must not cost time that grows with the square of its
// words: `bun -x` 20,000 times and `node` 40,000 times read in one pass per command (the review
// measured 101.5 s for the first before the fix). The bound is the test's own timeout.
test("hostile scripts read in time linear in their words", async () => {
  const repository = await repositoryWith({
    "packages/bunx/package.json": manifest({
      test: Array.from({ length: 20_000 }, () => "bun -x").join(" "),
    }),
    "packages/node/package.json": manifest({
      test: Array.from({ length: 40_000 }, () => "node").join(" "),
    }),
    "packages/node/src/x.ts": "",
  });
  const started = performance.now();
  const declarations = await read(repository);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(statusOf(declarations, "packages/node/src/x.ts")).toBe("not-test");
}, 20_000);

// Why: a near miss: a script word that names nothing in the tree, in a followed `bun test`, adds
// no undecided beyond what the rules already give.
test("a word that names nothing adds nothing", async () => {
  const repository = await repositoryWith({
    "package.json": manifest({
      test: "bun test ./tests --timeout 60000 integration",
      build: "tsc -b && prettier --write src",
    }),
    "tests/a.test.ts": "",
    "src/x.ts": "",
  });
  const declarations = await read(repository);
  expect(statuses(declarations, ["tests/a.test.ts", "src/x.ts"])).toEqual({
    "tests/a.test.ts": "test",
    // `prettier` never runs tests, so the `src` it is given names nothing.
    "src/x.ts": "not-test",
  });
});

// Why (Neuve's review, the ten neighbours): each shape lost a path a script named when the reader
// stopped, and Bun 1.4.4 ran the file in rows 1, 3, 4, 5, 8 and 9; every one now reads undecided,
// including a path outside the package (`../../shared/…`) beside an opaque word or after another
// runner's `--config`.
test("the ten neighbours of a lost named root are undecided", async () => {
  const repository = await repositoryWith(
    {
      ...shapes([
        {
          name: "n1",
          test: "bun test ./scripts/check.ts --path-ignore-patterns=unused",
        },
        {
          name: "n1b",
          test: "bun test --path-ignore-patterns=unused ./scripts/check.ts",
        },
        { name: "n2", test: "bun test ./tests --path-ignore-patterns=unused" },
        { name: "n3", test: "bun test ./scripts/check.ts ./missing" },
        { name: "n4", test: "bun test ./scripts/check.ts --timeout=$T" },
        { name: "n5", test: "bun test --cwd=. ./scripts/check.ts" },
        { name: "n7", test: "bun test ../../shared/n7.ts $X" },
        {
          name: "n8ignore",
          test: "bun test ./scripts/check.ts",
          bunfig: '[test]\npathIgnorePatterns = ["x/**"]\n',
        },
        {
          name: "n8root",
          test: "bun test ./scripts/check.ts",
          bunfig: '[test]\nroot = "./tests"\n',
        },
        {
          name: "n8toml",
          test: "bun test ./scripts/check.ts",
          bunfig: "[test\n",
        },
        { name: "n8link", test: "bun test ./scripts/check.ts" },
        { name: "n9", test: "bun --silent test ./scripts/check.ts" },
        {
          name: "n10",
          test: "bun ./wrap.ts ./scripts/check.ts",
          files: { "wrap.ts": "" },
          bunfig: "[test\n",
        },
        { name: "n12", test: "mocha --config x ../../shared/n12.ts" },
      ]),
      "shared/n7.ts": "",
      "shared/n12.ts": "",
      "configs/n8.toml": '[test]\nroot = "./tests"\n',
    },
    { "packages/n8link/bunfig.toml": "../../configs/n8.toml" },
  );
  const declarations = await read(repository);
  const rows: ReadonlyArray<[string, string]> = [
    ["packages/n1/scripts/check.ts", namedBy("n1")],
    ["packages/n1b/scripts/check.ts", namedBy("n1b")],
    ["packages/n2/tests/helper.ts", namedBy("n2")],
    ["packages/n3/scripts/check.ts", namedBy("n3")],
    ["packages/n4/scripts/check.ts", namedBy("n4")],
    ["packages/n5/scripts/check.ts", namedBy("n5")],
    ["shared/n7.ts", namedBy("n7")],
    ["packages/n8ignore/scripts/check.ts", namedBy("n8ignore")],
    ["packages/n8root/scripts/check.ts", namedBy("n8root")],
    ["packages/n8toml/scripts/check.ts", namedBy("n8toml")],
    ["packages/n8link/scripts/check.ts", namedBy("n8link")],
    ["packages/n9/scripts/check.ts", namedBy("n9")],
    ["packages/n10/scripts/check.ts", namedBy("n10")],
    ["shared/n12.ts", namedBy("n12")],
  ];
  for (const [path, by] of rows)
    expect({ path, status: statusOf(declarations, path) }).toEqual({
      path,
      status: by,
    });
});

// Why (review R3-1): `bun run <script> <words>` appends the words to the named script: Bun 1.4.4
// printed `$ node --test "scripts/*.mjs"` for `bun run test 'scripts/*.mjs'` and Node 24.8.0 ran
// `scripts/a.mjs`. So the words after the script's name are paths a runner gets: a glob, a
// directory, a file, after `--` or `--bun`; the name alone names nothing.
test("the words bun run passes to a script are named paths", async () => {
  const pkg = (
    name: string,
    ci: string,
    test: string,
    files: ReadonlyArray<string>,
  ) => ({
    [`packages/${name}/package.json`]: manifest({ test, ci }),
    [`packages/${name}/src/x.ts`]: "",
    ...Object.fromEntries(
      files.map((path) => [`packages/${name}/${path}`, ""]),
    ),
  });
  const repository = await repositoryWith({
    ...pkg("glob", "bun run test 'scripts/*.mjs'", "node --test", [
      "scripts/a.mjs",
    ]),
    ...pkg("dir", "bun run test ./scripts", "mocha", ["scripts/b.js"]),
    ...pkg("file", "bun run test ./scripts/c.js", "mocha", ["scripts/c.js"]),
    ...pkg("dashes", "bun run test -- ./scripts", "mocha", ["scripts/d.js"]),
    ...pkg("bunbun", "bun --bun run test ./scripts", "mocha", ["scripts/e.js"]),
    ...pkg("name", "bun run test", "mocha", ["test/f.json"]),
  });
  const declarations = await read(repository);
  expect(
    statuses(declarations, [
      "packages/glob/scripts/a.mjs",
      "packages/glob/src/x.ts",
      "packages/dir/scripts/b.js",
      "packages/file/scripts/c.js",
      "packages/dashes/scripts/d.js",
      "packages/bunbun/scripts/e.js",
      "packages/name/src/x.ts",
      "packages/name/test/f.json",
    ]),
  ).toEqual({
    "packages/glob/scripts/a.mjs": namedBy("glob", "ci"),
    "packages/glob/src/x.ts": "not-test",
    "packages/dir/scripts/b.js": namedBy("dir", "ci"),
    "packages/file/scripts/c.js": namedBy("file", "ci"),
    "packages/dashes/scripts/d.js": namedBy("dashes", "ci"),
    "packages/bunbun/scripts/e.js": namedBy("bunbun", "ci"),
    // The script's name (`test`, which is also a folder here) is not a path.
    "packages/name/src/x.ts": "not-test",
    "packages/name/test/f.json": "not-test",
  });
});

// Why (review R3-2): `cd .` repeated, or many `cd` targets, must not make every later word resolve
// against every one of them (the review measured 58.8 s at 20,000 repeats): the directories are
// kept once each, at most 16, and past that the package is undecided. The bound is the test's own
// timeout.
test("cd directories stay few and the scan stays linear", async () => {
  const repository = await repositoryWith({
    "packages/ifcd/package.json": manifest({
      test: Array.from(
        { length: 20_000 },
        () => "if true; then :; fi; cd .; ls x x",
      ).join("; "),
    }),
    "packages/ifcd/src/x.ts": "",
    "packages/runcd/package.json": manifest({
      test: `${Array.from({ length: 10_000 }, () => "cd .").join("; ")}; bun run t ${Array.from(
        { length: 10_000 },
        () => "x",
      ).join(" ")}`,
    }),
    "packages/many/package.json": manifest({
      test: `${Array.from({ length: 20 }, (_, i) => `cd d${i}`).join("; ")}; ls x`,
    }),
    "packages/many/src/x.ts": "",
  });
  const started = performance.now();
  const declarations = await read(repository);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(statusOf(declarations, "packages/ifcd/src/x.ts")).toBe("not-test");
  expect(statusOf(declarations, "packages/many/src/x.ts")).toBe(
    `script-paths: packages/many/package.json script "test" changes directory to more than 16 places, so any file in the package may be one it names`,
  );
}, 30_000);

// Why (review R3-3): AVA run from a root with no configuration globs its `**/tests/**` default over
// the whole project, workspaces included (AVA's `lib/globs.js`), so a file in a workspace whose own
// manifest is empty is undecided when a package above it names AVA. tap's default folders are
// top-level only, so only the root's own `tests/` counts for it.
test("a runner's default reaches the workspaces of the package that names it", async () => {
  const ava = await repositoryWith({
    "package.json": JSON.stringify({
      scripts: { test: "ava" },
      devDependencies: { ava: "6" },
      workspaces: ["packages/*"],
    }),
    "packages/x/package.json": "{}",
    "packages/x/tests/foo.js": "",
  });
  expect(statusOf(await read(ava), "packages/x/tests/foo.js")).toBe(
    "test-conventions: matches AVA's default test files (**/tests/**/*.{js,cjs,mjs}) in a package that names AVA, a runner the reader does not read",
  );
  const tap = await repositoryWith({
    "package.json": JSON.stringify({
      scripts: { test: "tap" },
      workspaces: ["packages/*"],
    }),
    "tests/foo.js": "",
    "packages/y/package.json": "{}",
    "packages/y/tests/foo.js": "",
  });
  const declarations = await read(tap);
  expect(
    statuses(declarations, ["tests/foo.js", "packages/y/tests/foo.js"]),
  ).toEqual({
    "tests/foo.js":
      "test-conventions: matches tap's default test files ({test,tests,__tests__}/** (top-level folders)) in a package that names tap, a runner the reader does not read",
    "packages/y/tests/foo.js": "not-test",
  });
});

/** Whether a path reads undecided, whatever its `by`. */
const undecidedIn = (declarations: ReadDeclarations, path: string) =>
  typeof testStatusOf(declarations, path) === "object";

// Why (Neuve's round 16, group 1, and the closing rule): where the reader does not follow a
// script (after `cd`, under `if`/`fi`, in a subshell, in a chain after `cd`), a pinned runner may
// collect any file of the package (pytest's `--doctest-modules`, Jest's `--testRegex`, a Mocha
// `--config`, a Mocha glob), and so may `bun test` run from a directory the reader moved to.
test("a pinned runner or an interpreter the reader does not follow reaches its package", async () => {
  const forms: Record<string, [string, string]> = {
    cdpytest: ["cd ./checks && pytest --doctest-modules", "checks/helper.py"],
    cdjest: ["cd ./checks && jest --testRegex=check", "checks/helper.js"],
    cdmocha: [
      "cd ./checks && mocha --config ../conf/m.json",
      "checks/helper.js",
    ],
    ifpytest: [
      "if true; then pytest --doctest-modules; fi",
      "checks/helper.py",
    ],
    ifjest: ["if true; then jest --testRegex=check; fi", "checks/helper.js"],
    ifmocha: [
      "if true; then mocha --config conf/m.json; fi",
      "checks/helper.js",
    ],
    subpytest: ["(pytest --doctest-modules)", "checks/helper.py"],
    subjest: ["(jest --testRegex=check)", "checks/helper.js"],
    submocha: ["(mocha --config conf/m.json)", "checks/helper.js"],
    ifglob: ["if true; then mocha ./checks/*; fi", "checks/unit/check.js"],
    cdbun: ["cd ./checks && bun test", "checks/helper.js"],
    chain: [
      "true && cd ./checks && jest --testRegex=check",
      "checks/helper.js",
    ],
  };
  const files: Record<string, string> = {};
  for (const [name, [test]] of Object.entries(forms))
    for (const [path, body] of Object.entries({
      "package.json": manifest({ test }),
      "checks/helper.js": "",
      "checks/helper.py": "",
      "checks/unit/check.js": "",
      "conf/m.json": "{}",
    }))
      files[`packages/${name}/${path}`] = body;
  const declarations = await read(await repositoryWith(files));
  for (const [name, [, path]] of Object.entries(forms))
    expect({
      name,
      undecided: undecidedIn(declarations, `packages/${name}/${path}`),
    }).toEqual({
      name,
      undecided: true,
    });
});

// Why (Neuve's round 16, group 5): Node ran the `node:test` file `node $SCRIPT` named (1 pass), so
// an interpreter given an opaque word in a followed script may run any file of its package; the
// same for `node --import ./x.js $SCRIPT` and `python $X`.
test("an interpreter given an opaque word reaches its package", async () => {
  const forms = ["node $SCRIPT", "node --import ./x.js $SCRIPT", "python $X"];
  const files: Record<string, string> = {};
  forms.forEach((test, index) => {
    files[`packages/p${index}/package.json`] = manifest({ test });
    files[`packages/p${index}/x.js`] = "";
    files[`packages/p${index}/scripts/check.js`] = "";
  });
  const declarations = await read(await repositoryWith(files));
  forms.forEach((test, index) =>
    expect({
      test,
      undecided: undecidedIn(
        declarations,
        `packages/p${index}/scripts/check.js`,
      ),
    }).toEqual({
      test,
      undecided: true,
    }),
  );
});

// Why (review R4-1): Bun and Node ran `sub/lib/a.mjs` for `bun run --cwd ./sub test ./lib/a.mjs`
// and its `--cwd=` form: Bun's `--cwd` moves the run, so the words after it resolve there, before
// or after `run`, and with `bun test`; under `--filter` the words reach every workspace.
test("Bun's --cwd moves the paths a command names", async () => {
  const forms = [
    "bun run --cwd ./sub test ./lib/a.mjs",
    "bun run --cwd=./sub test ./lib/a.mjs",
    "bun --cwd=./sub run test ./lib/a.mjs",
    "bun --cwd=./sub test ./lib/a.mjs",
    "bun run --filter sub test ./lib/a.mjs",
  ];
  const files: Record<string, string> = {};
  forms.forEach((ci, index) => {
    files[`packages/r${index}/package.json`] = manifest({ ci });
    files[`packages/r${index}/sub/package.json`] = JSON.stringify({
      name: "sub",
      scripts: { test: "node --test" },
    });
    files[`packages/r${index}/sub/lib/a.mjs`] = "";
  });
  const declarations = await read(await repositoryWith(files));
  forms.forEach((ci, index) =>
    expect({
      ci,
      undecided: undecidedIn(declarations, `packages/r${index}/sub/lib/a.mjs`),
    }).toEqual({
      ci,
      undecided: true,
    }),
  );
});

// Why (Neuve's round 34): a manifest the reader cannot read may hold scripts that run any file of
// its package, so every path of that package reads undecided (the coordinator's scope, the same as
// an opaque word's); a path outside it is left to the other rules (a known limit).
test("a manifest the reader cannot read reaches its own package", async () => {
  const declarations = await read(
    await repositoryWith({
      "packages/tools/package.json":
        '{"scripts": {"test": "bun test ../../src/check.ts"',
      "packages/tools/lib/x.ts": "",
      "packages/other/package.json": manifest({ build: "tsc -b" }),
      "packages/other/lib/y.ts": "",
    }),
  );
  expect(
    statuses(declarations, [
      "packages/tools/lib/x.ts",
      "packages/other/lib/y.ts",
    ]),
  ).toEqual({
    "packages/tools/lib/x.ts":
      "package-scripts-bun-test: packages/tools/package.json is not valid JSON, so its scripts were not read",
    "packages/other/lib/y.ts": "not-test",
  });
});

// Why (Neuve's round 34): Mocha's `--recursive` takes no value, so the glob after it is a spec;
// whatever a runner's flag reading makes of it, the named-path scan reads every word, so the files
// it matches are undecided.
test("a glob after a runner's valueless flag is still a named path", async () => {
  const declarations = await read(
    await repositoryWith({
      "package.json": manifest({ test: "mocha --recursive 'checks/*.js'" }),
      "checks/a.js": "",
      "src/x.ts": "",
    }),
  );
  expect(statuses(declarations, ["checks/a.js", "src/x.ts"])).toEqual({
    "checks/a.js": 'script-paths: package.json script "test" names this path',
    // `--recursive` changes what Mocha collects, so the rest of the package is undecided too.
    "src/x.ts":
      'runner-commands: package.json script "test" runs Mocha with --recursive, which changes the files it collects, so any file in the package may be one of its tests',
  });
});

// Why (Neuve, readers' round): a script that returns to a directory it already visited and moves
// on (`cd a && cd .. && cd b`, or `pushd a && popd && cd b`) runs its later commands in `b`, so
// `b/probe.js` is a path it names; the current directory follows every move, while the cap of 16
// still counts distinct directories.
test("the current directory follows a revisited directory", async () => {
  for (const test of [
    "cd a && cd .. && cd b && custom-runner probe.js",
    "pushd a && popd && cd b && custom-runner probe.js",
  ]) {
    const declarations = await read(
      await repositoryWith({
        "package.json": manifest({ test }),
        "a/x.js": "",
        "b/probe.js": "",
      }),
    );
    expect({ test, status: statusOf(declarations, "b/probe.js") }).toEqual({
      test,
      status: 'script-paths: package.json script "test" names this path',
    });
  }
});

// The integration commit that landed as main on 13 November (batch 4).
const PINNED = "0af3643b1317fd76c7b796d91d2ac0e07da3b5b2";
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

const ROOT_TEST_BY = `package-scripts-bun-test: package.json script "test:root" uses --path-ignore-patterns, which the reader does not follow`;

// Why: this repository is the case the third state was built for: the root `tests/` files that
// `test:root` runs must be undecided, not not-test, and no file the reader declared a test is lost.
test.skipIf(!pinnedPresent)(
  "this repository at a pinned commit: its root tests are undecided",
  async () => {
    const tree = await Effect.runPromise(lsTree(repository, PINNED));
    const blobs = tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    const named = blobs.filter((path) =>
      BUN_TEST_FILE.test(path.split("/").at(-1) ?? ""),
    );
    const counts = (declarations: ReadDeclarations) => {
      const status = { test: 0, "not-test": 0, undecided: 0 };
      for (const path of named) {
        const each = testStatusOf(declarations, path);
        status[typeof each === "string" ? each : "undecided"]++;
      }
      return status;
    };
    const declarations = await Effect.runPromise(
      readDeclarations({
        repository,
        revision: PINNED,
        tree,
        paths: named,
      }),
    );
    expect(named.length).toBe(732);
    // 710 declared tests: the same files the reader declared before this change.
    expect(counts(declarations)).toEqual({
      test: 710,
      "not-test": 0,
      undecided: 22,
    });
    const rootTests = named.filter((path) => /^tests\/[^/]+$/.test(path));
    expect(rootTests.length).toBe(18);
    for (const path of rootTests)
      expect({ path, by: declarations.undecided.get(path) }).toEqual({
        path,
        by: ROOT_TEST_BY,
      });
    // `test:release` is followed: its files stay tests.
    expect(
      named
        .filter((path) => path.startsWith("tests/release/"))
        .every((path) => testStatusOf(declarations, path) === "test"),
    ).toBe(true);
    // The full tree as both tree and paths, without the marker, as the readers lane reads it.
    const full = await Effect.runPromise(
      readDeclarations({
        repository,
        revision: PINNED,
        tree,
        paths: blobs,
        markers: false,
      }),
    );
    expect(counts(full)).toEqual({ test: 710, "not-test": 0, undecided: 22 });
    expect(full.gaps).toEqual(DECLARATION_GAPS);
    expect(
      [...full.byPath.values()]
        .flat()
        .some((entry) => entry.by.startsWith("generated-marker")),
    ).toBe(false);
    for (const path of named)
      expect(testStatusOf(full, path)).toEqual(
        testStatusOf(declarations, path),
      );
  },
  120_000,
);
