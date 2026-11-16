import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { z } from "zod";
import { CaseRecord, type CaseRecord as Case } from "../../pr-replay/schema.ts";
import { leakageChecks } from "../../pr-replay/prepare.ts";
import { git as gitRun, run } from "../../pr-replay/providers.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import {
  changedBaseLines,
  changedHeadLines,
  checkKind,
  lightShapeProblem,
  plantCommit,
  plantFiles,
  type LightKind,
  type PlantFile,
} from "./planted.ts";
import { readHost, type Host } from "./planted-light.ts";

/**
 * Set C of the finders' quality gate (NEU-148, WP12): problems planted in ordinary source, the kinds
 * set B's light files cannot show. Each variant is one host case and one commit on the host's
 * first-revision head that plants one problem in one real file, so the variant's range is the host's
 * base to the planted commit: the host's own change plus the plant.
 *
 * Five categories, each with its own shape (`sourceShapeProblem`):
 *
 * - `source-defect`: a correctness defect in a file the host's change touches; added lines.
 * - `removed-behaviour`: deleted lines only, deleting behaviour something still needs (`related`).
 * - `cross-file`: a changed contract in one file that a second file, which the plant leaves alone,
 *   still relies on (`related`).
 * - `missing-test`: a new or changed branch with no test, in a host whose range changes tests.
 * - `out-of-scope`: a working edit in a module none of the host's files lives in.
 *
 * Plants are data: `PLANTS` holds one entry per variant, with its own fixed number. The builder walks
 * the entries, builds the ones with no folder yet and re-derives the existing ones in place to prove
 * their bytes have not moved, then re-pins the whole index. Adding a plant is adding one entry with
 * the next number; nothing existing is renumbered or rebuilt. Every value a record holds comes from
 * the hosts' git objects and the entry, never the clock, so a rebuild writes the same bytes.
 *
 * The answer key (`planted.json`) stays beside the clone, outside it; the clone holds the host's
 * commits plus one ordinary-looking commit by the host head's author, checked with set B's leakage
 * checks.
 */

export const CATEGORIES = [
  "source-defect",
  "removed-behaviour",
  "cross-file",
  "missing-test",
  "out-of-scope",
  "test-file",
  "family",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** The builder's shape class per category, recorded as `kind`. */
export const KIND_OF: Readonly<Record<Category, string>> = {
  "source-defect": "source-changed-in-range",
  "removed-behaviour": "source-deletion-only",
  "cross-file": "source-contract-change",
  "missing-test": "source-untested-branch",
  "out-of-scope": "source-outside-range",
  "test-file": "test-cannot-catch",
  family: "repeated-change-one-deviant",
};

/** Languages by extension, as Graph names them. */
const LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.go$/, "Go"],
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/, "JavaScript"],
  [/\.py$/, "Python"],
  [/\.rs$/, "Rust"],
];
export const languageOf = (path: string) =>
  LANGUAGES.find(([pattern]) => pattern.test(path))?.[1] ?? null;

const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.repos)\//;

/** Python's test files, which the light census's path rule does not name. */
const PYTHON_TEST = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/;

/** The light classes set B's builder names, against which ordinary source is judged. */
const LIGHT_CLASSES: ReadonlyArray<LightKind> = [
  "light-lockfile",
  "light-tests",
  "light-docs",
  "light-fixtures",
  "light-generated",
  "light-import-only",
  "light-declaration-only",
];

/** The light classes a path alone decides. */
const PATH_CLASSES: ReadonlyArray<LightKind> = [
  "light-lockfile",
  "light-tests",
  "light-docs",
  "light-fixtures",
];

/** Whether a path is a test file: the light review's census, and Python's own test names. */
export const isTestPath = (path: string) =>
  PYTHON_TEST.test(path) ||
  lightShapeProblem("light-tests", [{ path, added: [], deleted: [] }]) === null;

/** Why a path, alone, is not ordinary source; null when it may be. */
export const sourcePathProblem = (path: string): string | null => {
  if (VENDORED.test(path)) return `${path} is vendored`;
  if (PYTHON_TEST.test(path)) return `${path} is tests`;
  for (const kind of PATH_CLASSES)
    if (lightShapeProblem(kind, [{ path, added: [], deleted: [] }]) === null)
      return `${path} is ${kind.replace("light-", "")}`;
  return languageOf(path) === null
    ? `${path} is not in a planted language`
    : null;
};

/** A comment line in the file's language. */
export const isCommentLine = (text: string, path: string) =>
  languageOf(path) === "Python"
    ? /^\s*#/.test(text)
    : /^\s*(\/\/|\/\*|\*\/|\*(\s|$))/.test(text);

/** An import line the light census's own rule misses: Python's and Rust's forms. */
const isOwnImportLine = (text: string, path: string) => {
  const language = languageOf(path);
  if (language === "Python")
    return /^\s*(import\s|from\s+\S+\s+import\b)/.test(text);
  if (language === "Rust")
    return /^\s*((pub(\([^)]*\))?\s+)?use\s|extern\s+crate\s|(pub\s+)?mod\s+\w+\s*;)|^\s*[\w:]+(\s+as\s+\w+)?\s*,?\s*$|^\s*\}\s*;?\s*$/.test(
      text,
    );
  return false;
};

/**
 * Why one file of a plant's own diff is not ordinary source; null when it is. Ordinary source is a
 * file in a known language, outside vendored trees, of no light class: not a lockfile, test, doc,
 * fixture or generated file, and its change is not import-only, declaration-only or comment-only.
 * The file must exist both before and after the plant (a whole-file addition or deletion is not an
 * edit).
 */
export const ordinarySourceProblem = (
  file: PlantFile & { readonly existedBefore: boolean },
): string | null => {
  if (VENDORED.test(file.path)) return `${file.path} is vendored`;
  if (!file.existedBefore) return `${file.path} is a new file`;
  if (file.head === undefined) return `${file.path} is deleted`;
  if (PYTHON_TEST.test(file.path)) return `${file.path} is tests`;
  for (const kind of LIGHT_CLASSES)
    if (lightShapeProblem(kind, [file]) === null)
      return `${file.path} is ${kind.replace("light-", "")}`;
  if (languageOf(file.path) === null)
    return `${file.path} is not in a planted language`;
  const changed = [...file.added, ...file.deleted].filter(
    (line) => line.trim() !== "",
  );
  if (
    changed.length > 0 &&
    changed.every((line) => isOwnImportLine(line, file.path))
  )
    return `${file.path} is import-only`;
  if (
    changed.length > 0 &&
    changed.every((line) => isCommentLine(line, file.path))
  )
    return `${file.path} changes only comments`;
  return null;
};

/** What a category's shape rule needs to know beyond the plant's own diff. */
export interface ShapeContext {
  /** Files the host's own range changes. */
  readonly hostFiles: ReadonlySet<string>;
  /** Paths `related` names. */
  readonly relatedPaths: ReadonlyArray<string>;
}

/** Whether one directory is the other, inside it, or holds it; the repository root holds no module. */
const sameModule = (a: string, b: string) =>
  a === b ||
  (b !== "." && a.startsWith(`${b}/`)) ||
  (a !== "." && b.startsWith(`${a}/`));

/**
 * Why a plant's own diff does not have its category's shape; null when it does. A plant of the wrong
 * shape would score a category it is not in, so each category's rule is enforced on the built diff.
 */
export const sourceShapeProblem = (
  category: Category,
  files: ReadonlyArray<PlantFile & { readonly existedBefore: boolean }>,
  context: ShapeContext,
): string | null => {
  if (category === "test-file") return testFileShapeProblem(files, context);
  if (category === "family") {
    const pattern = familyPattern(files);
    return typeof pattern === "string" ? pattern : null;
  }
  if (files.length !== 1)
    return `a plant edits exactly one file, this one edits ${files.length}`;
  const file = files[0]!;
  const ordinary = ordinarySourceProblem(file);
  if (ordinary !== null) return ordinary;
  for (const path of context.relatedPaths) {
    const problem = sourcePathProblem(path);
    if (problem !== null) return `related ${problem}`;
  }
  const meaningful = (lines: ReadonlyArray<string>) =>
    lines.filter(
      (line) => line.trim() !== "" && !isCommentLine(line, file.path),
    ).length;
  const added = meaningful(file.added);
  const deleted = meaningful(file.deleted);
  switch (category) {
    case "source-defect":
      if (!context.hostFiles.has(file.path))
        return `a source defect sits in a file the host's change touches, and ${file.path} is not one`;
      return added === 0 ? "a source defect adds or changes lines" : null;
    case "removed-behaviour":
      if (file.added.length > 0) return "removed behaviour deletes lines only";
      if (deleted === 0)
        return "removed behaviour deletes at least one line of code";
      return context.relatedPaths.length === 0
        ? "removed behaviour names the code that still needs it (related)"
        : null;
    case "cross-file":
      if (added === 0) return "a cross-file plant changes a contract line";
      if (context.relatedPaths.length === 0)
        return "a cross-file plant names the dependent code (related)";
      return context.relatedPaths.some((path) => path === file.path)
        ? "a cross-file plant's related file must be one the plant does not touch"
        : null;
    case "missing-test":
      if (![...context.hostFiles].some(isTestPath))
        return "a missing-test plant needs a host whose range changes tests";
      return added === 0
        ? "a missing-test plant adds or changes a branch"
        : null;
    case "out-of-scope": {
      if (context.hostFiles.has(file.path))
        return `an out-of-scope plant sits outside the host's files, and ${file.path} is one`;
      const directory = posix.dirname(file.path);
      const near = [...context.hostFiles]
        .map((path) => posix.dirname(path))
        .find((host) => sameModule(directory, host));
      return near === undefined
        ? null
        : `an out-of-scope plant sits in a module the host does not touch, and ${directory} is ${near} or beside it`;
    }
  }
};

/**
 * Why a test-file plant does not have its shape; null when it does. The plant touches only test
 * files (as set B's census and Python's test names judge them), adds or changes test lines, and
 * names as `related` the changed behaviour it fails to cover: source the host's range changes.
 */
export const testFileShapeProblem = (
  files: ReadonlyArray<PlantFile & { readonly existedBefore: boolean }>,
  context: ShapeContext,
): string | null => {
  if (files.length === 0) return "the plant changes nothing";
  for (const file of files) {
    if (VENDORED.test(file.path)) return `${file.path} is vendored`;
    if (!isTestPath(file.path))
      return `a test-file plant touches only test files, and ${file.path} is not one`;
    if (languageOf(file.path) === null)
      return `${file.path} is not in a planted language`;
  }
  const added = files
    .flatMap((f) => f.added)
    .filter(
      (line) => line.trim() !== "" && !isCommentLine(line, files[0]!.path),
    );
  if (added.length === 0) return "a test-file plant adds or changes test lines";
  if (context.relatedPaths.length === 0)
    return "a test-file plant names the behaviour it fails to cover (related)";
  for (const path of context.relatedPaths) {
    if (isTestPath(path)) return `related ${path} is a test, not the behaviour`;
    const problem = sourcePathProblem(path);
    if (problem !== null) return `related ${problem}`;
    if (!context.hostFiles.has(path))
      return `related ${path} is not a file the host's range changes`;
  }
  return null;
};

const FAMILY_KEYWORDS = new Set([
  "if",
  "else",
  "return",
  "for",
  "range",
  "func",
  "const",
  "let",
  "var",
  "nil",
  "null",
  "undefined",
  "new",
  "await",
  "async",
  "function",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "defer",
  "go",
]);
// Strings come first, so a comment marker inside a string stays part of the string.
const FAMILY_TOKEN =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|\/\*.*?\*\/|\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*|\S/g;
const FAMILY_TOKEN_HASH_COMMENTS =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*|\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*|\S/g;
const isCommentToken = (token: string) => /^(\/\/|\/\*|#)/.test(token);

/**
 * A changed row with comments dropped and identifiers normalised; literals masked, or kept. A
 * template string's `${…}` expressions are code, not literal text: they are normalised like any
 * other code, so two copies apart only in an interpolated name are not apart in a literal.
 */
export const familyRow = (
  line: string,
  keepLiterals: boolean,
  hashComments = false,
): string =>
  (line.match(hashComments ? FAMILY_TOKEN_HASH_COMMENTS : FAMILY_TOKEN) ?? [])
    .filter((token) => !isCommentToken(token))
    .map((token) => {
      if (token.startsWith("`") && token.includes("${")) {
        const expressions = [...token.matchAll(/\$\{([^}]*)\}/g)].map(
          (match) => `\${ ${familyRow(match[1]!, keepLiterals)} }`,
        );
        if (!keepLiterals) return `LIT ${expressions.join(" ")}`;
        let at = 0;
        return token.replace(/\$\{([^}]*)\}/g, () => expressions[at++]!);
      }
      const literal =
        /^["'`\d]/.test(token) || token === "true" || token === "false";
      if (literal) return keepLiterals ? token : "LIT";
      if (/^[A-Za-z_$]/.test(token))
        return FAMILY_KEYWORDS.has(token) ? token : "ID";
      return token;
    })
    .join(" ");

/**
 * A family plant's pattern: five or more files, ordinary source in one language, whose changed rows
 * are equal once identifiers are normalised and literals masked, and of which exactly one copy, not
 * the first by path, differs when literals are kept. Returns the deviant's index in path order, or
 * why the files are not such a family.
 */
export const familyPattern = (
  files: ReadonlyArray<PlantFile & { readonly existedBefore: boolean }>,
):
  | { readonly deviant: number; readonly paths: ReadonlyArray<string> }
  | string => {
  if (files.length < 5)
    return `a family plant edits five or more files, this one edits ${files.length}`;
  for (const file of files) {
    const ordinary = ordinarySourceProblem(file);
    if (ordinary !== null) return ordinary;
  }
  if (new Set(files.map((f) => languageOf(f.path))).size !== 1)
    return "a family plant's copies are in one language";
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const rows = (file: PlantFile, keep: boolean) => {
    const hash = languageOf(file.path) === "Python";
    const side = (lines: ReadonlyArray<string>, sign: string) =>
      lines
        .filter((l) => l.trim() !== "" && !isCommentLine(l, file.path))
        .map((l) => familyRow(l, keep, hash))
        .filter((row) => row !== "")
        .map((row) => `${sign}${row}`);
    return JSON.stringify([
      ...side(file.deleted, "-"),
      ...side(file.added, "+"),
    ]);
  };
  const masked = new Set(sorted.map((f) => rows(f, false)));
  if (masked.size !== 1)
    return "a family plant's copies differ beyond literals once identifiers are normalised";
  const kept = sorted.map((f) => rows(f, true));
  const counts = new Map<string, number>();
  for (const k of kept) counts.set(k, (counts.get(k) ?? 0) + 1);
  const lone = [...counts].filter(([, n]) => n === 1);
  if (counts.size !== 2 || lone.length !== 1)
    return "exactly one copy of a family plant differs from the others in a literal";
  const deviant = kept.indexOf(lone[0]![0]);
  if (deviant === 0)
    return "a family plant's deviating copy is not the first by path";
  return { deviant, paths: sorted.map((f) => f.path) };
};

/** The gate's naming rule: a word, case-insensitively, not inside a longer identifier. */
export const namesWord = (word: string, text: string) =>
  new RegExp(
    `(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
    "i",
  ).test(text);

/** Directory names too common to say which file a finding read. */
const GENERIC_DIRECTORIES = new Set([
  "src",
  "lib",
  "libs",
  "internal",
  "pkg",
  "cmd",
  "app",
  "apps",
  "packages",
  "package",
  "core",
  "common",
  "shared",
  "util",
  "utils",
  "scripts",
  "server",
  "client",
  "web",
  "components",
  "views",
  "front_end",
]);

/** A related path's distinctive directory names (a package or module name a finding may use). */
export const distinctiveDirectories = (path: string) =>
  posix
    .dirname(path)
    .split("/")
    .filter((part) => part !== "." && !GENERIC_DIRECTORIES.has(part));

/**
 * Why a cross-file plant's words would not tell whether the second file was seen; null when they
 * would. Each mention must appear in the dependent code or be a distinctive directory name of its
 * path, and neither a mention nor a related file's name may appear in the plant's own added or
 * deleted lines, its path or its commit message, or any finding on the plant would read as naming
 * the dependency. When `fileText` (the planted file at the variant's head) is given, no mention may
 * appear anywhere in it either: a finding that echoes another line of the planted file must not read
 * as naming the dependency. A related file's name is still judged against the plant's own lines only.
 */
export const crossFileWordsProblem = (input: {
  readonly mentions: ReadonlyArray<string>;
  readonly relatedTexts: ReadonlyArray<string>;
  readonly relatedPaths: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly deleted?: ReadonlyArray<string>;
  readonly message?: string;
  readonly plantPath: string;
  readonly fileText?: string;
}): string | null => {
  const own = [
    ...input.added,
    ...(input.deleted ?? []),
    input.message ?? "",
    input.plantPath,
  ].join("\n");
  const sources = [
    ...input.relatedTexts,
    ...input.relatedPaths.flatMap(distinctiveDirectories),
  ];
  for (const mention of input.mentions) {
    if (!sources.some((text) => namesWord(mention, text)))
      return `the mention "${mention}" is not in the dependent code`;
    if (namesWord(mention, own))
      return `the mention "${mention}" is in the plant's own lines`;
    if (input.fileText !== undefined && namesWord(mention, input.fileText))
      return `the mention "${mention}" is in the planted file`;
  }
  for (const path of input.relatedPaths)
    for (const name of [path, posix.basename(path)])
      if (namesWord(name, own))
        return `the related file ${name} is named by the plant's own lines`;
  return null;
};

// Plants

const Edit = z.strictObject({
  /** Text that occurs exactly once in the file at the host's head. */
  find: z.string().min(1),
  replace: z.string(),
});

/**
 * How a test-file plant's test fails to test the change: it cannot fail (forged), it runs the
 * changed code without asserting the change (no-assert), or it never reaches the changed branch
 * (wrong-path).
 */
export const TEST_FORMS = ["forged", "no-assert", "wrong-path"] as const;

export const PlantSpec = z.strictObject({
  /** The variant's number, fixed for good: numbers are append-only from 101. */
  variant: z.int().min(101),
  /** The host case, `<source>/<number>` under the research volume's cases. */
  host: z.string().regex(/^[a-z0-9-]+\/\d+$/),
  category: z.enum(CATEGORIES),
  path: z.string().min(1),
  edits: z.array(Edit).min(1),
  /** Code the defect depends on, located by text (unique) at the variant's head. */
  related: z
    .array(z.strictObject({ path: z.string().min(1), find: z.string().min(1) }))
    .default([]),
  mentions: z.array(z.string().min(1)).min(1),
  message: z.string().min(1),
  description: z.string().min(1),
  /** The builder's judgement, recorded and never scored; every plant from 119 on has one. */
  difficulty: z.enum(["plain", "subtle"]).optional(),
  /**
   * Deleted lines (exact text) of a plant that also adds lines, whose old-side lines are planted
   * lines too: for a defect whose natural anchor is a line it removed. They move from `beside` into
   * `lines`. Removed behaviour already keys its deleted lines.
   */
  deletedAsPlanted: z.array(z.string().min(1)).optional(),
  /** A test-file plant's form: how the new test fails to test the change (test-file only). */
  form: z.enum(TEST_FORMS).optional(),
  /** A family plant's other copies: the same change in further files (family only). */
  extraFiles: z
    .array(
      z.strictObject({ path: z.string().min(1), edits: z.array(Edit).min(1) }),
    )
    .optional(),
});
export type PlantSpec = z.input<typeof PlantSpec>;

/**
 * Every plant of set C, one entry each. Append a new entry with the next free number; never edit,
 * renumber or remove an entry once its variant is built (the build refuses a variant whose
 * re-derived bytes differ from what is on disk).
 */
export const PLANTS: ReadonlyArray<PlantSpec> = [
  {
    variant: 101,
    host: "entire-cli/740",
    category: "source-defect",
    path: "cmd/entire/cli/login.go",
    edits: [
      {
        find: "\t\tif err := openURL(ctx, browserURL); err != nil {",
        replace: "\t\tif err := openURL(ctx, displayURL); err != nil {",
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/login.go",
        find: "\t// Use the clean URL (without code) for display, but open the complete URL\n\t// (with code pre-filled) in the browser for a smoother experience.",
      },
    ],
    mentions: ["displayURL", "browserURL", "openURL"],
    message: "Tidy login URL handling",
    description:
      "runLogin opens the display URL, not the complete URL with the code, contrary to the comment above it",
  },
  {
    variant: 102,
    host: "t3code/8922",
    category: "source-defect",
    path: "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
    edits: [
      {
        find: '{flow.submitting && environmentConnected && flow.workspaceMode === "worktree" ? (',
        replace:
          '{flow.submitting && environmentConnected && flow.workspaceMode === "local" ? (',
      },
    ],
    mentions: ["workspaceMode", "Setting up worktree", "local"],
    message: "Polish the draft composer's workspace row",
    description:
      'the "Setting up worktree" row now shows when submitting in the local checkout, and never for a new worktree',
  },
  {
    variant: 103,
    host: "react-core/21583",
    category: "source-defect",
    path: "packages/react-devtools-shared/src/devtools/views/Components/InspectedElement.js",
    edits: [
      {
        find: "      if (nearestErrorBoundary !== element) {",
        replace: "      if (nearestErrorBoundary === element) {",
      },
    ],
    mentions: ["nearestErrorBoundary", "SELECT_ELEMENT_BY_ID"],
    message: "Clean up the error toggle",
    description:
      "toggling an error selects the nearest error boundary only when it is already the selected element, so forcing an error from a child leaves the selection on the child the error unmounts",
  },
  {
    variant: 104,
    host: "t3code/24056",
    category: "removed-behaviour",
    path: "apps/desktop/src/preview/DesktopBrowserHost.ts",
    edits: [
      {
        find: '    tabs.delete(id);\n    tab.debuggee.debugger.off("message", tab.onMessage);\n',
        replace: "    tabs.delete(id);\n",
      },
    ],
    related: [
      {
        path: "apps/desktop/src/preview/DesktopBrowserHost.ts",
        find: '    debuggee.debugger.on("message", tab.onMessage);',
      },
    ],
    mentions: ['off("message"', "onMessage", "detach"],
    message: "Simplify tab detach",
    description:
      "detach no longer removes the debugger's message listener that attach adds, so a detached or re-attached tab keeps relaying CDP events",
  },
  {
    variant: 105,
    host: "go/279487",
    category: "removed-behaviour",
    path: "src/internal/fuzz/fuzz.go",
    edits: [
      {
        find: "\t\tclose(c.doneC)\n\t\twg.Wait()\n",
        replace: "\t\tclose(c.doneC)\n",
      },
    ],
    related: [
      {
        path: "src/internal/fuzz/fuzz.go",
        find: "\t// Before returning, signal workers to stop, wait for them to actually stop,\n\t// and gather any errors they encountered.",
      },
      {
        path: "src/internal/fuzz/fuzz.go",
        find: "\t\t\tdefer wg.Done()\n\t\t\tworkerErrs[i] = workers[i].runFuzzing()",
      },
    ],
    mentions: ["wg.Wait", "workerErrs"],
    message: "[dev.fuzz] internal/fuzz: simplify coordinator shutdown",
    description:
      "the coordinator no longer waits for its workers before reading their errors, so it races them and returns before they stop and clean up",
  },
  {
    variant: 106,
    host: "react-core/22978",
    category: "removed-behaviour",
    path: "packages/react-devtools-shared/src/devtools/views/Components/NativeStyleEditor/context.js",
    edits: [
      {
        find: "        onStyleAndLayout,\n      );\n\n      if (timeoutID !== null) {\n        clearTimeout(timeoutID);\n      }\n    };\n  }, [bridge, selectedElementID, store]);",
        replace:
          "        onStyleAndLayout,\n      );\n    };\n  }, [bridge, selectedElementID, store]);",
      },
    ],
    related: [
      {
        path: "packages/react-devtools-shared/src/devtools/views/Components/NativeStyleEditor/context.js",
        find: "        timeoutID = setTimeout(sendRequest, 1000);",
      },
    ],
    mentions: ["clearTimeout", "timeoutID", "sendRequest"],
    message: "Tidy the style editor's polling effect",
    description:
      "the polling effect's cleanup no longer clears its pending timer, so after the selection changes or the editor unmounts the old element is measured again",
  },
  {
    variant: 107,
    host: "devtools-frontend/2097982",
    category: "removed-behaviour",
    path: "scripts/deps/download_chromium.py",
    edits: [
      {
        find: "    with open(BUILD_NUMBER_FILE, 'w') as file:\n        file.write(options.build_number)\n",
        replace: "",
      },
    ],
    related: [
      {
        path: "scripts/deps/download_chromium.py",
        find: "    if os.path.exists(BUILD_NUMBER_FILE):\n        with open(BUILD_NUMBER_FILE) as file:\n            build_number = file.read().strip()\n            if build_number == options.build_number:",
      },
    ],
    mentions: ["BUILD_NUMBER_FILE", "build_number"],
    message: "Clean up the Chromium download script",
    description:
      "the script no longer records the downloaded build number, so the up-to-date check never matches and every run deletes and downloads Chromium again",
  },
  {
    variant: 108,
    host: "t3code/24554",
    category: "cross-file",
    path: "apps/server/src/auth/SessionStore.ts",
    edits: [
      {
        find: "      ...(claims.aud ? { audience: claims.aud } : {}),\n      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),\n    } satisfies VerifiedWebSocketTicket;",
        replace:
          '      // A ticket minted without a route predates route binding: it opens the RPC socket.\n      audience: claims.aud ?? "rpc",\n      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),\n    } satisfies VerifiedWebSocketTicket;',
      },
    ],
    related: [
      {
        path: "apps/server/src/auth/EnvironmentAuth.ts",
        find: "          if (session.audience !== undefined && session.audience !== use) {",
      },
      {
        path: "apps/server/src/auth/http.ts",
        find: '    const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "media").pipe(',
      },
      {
        path: "packages/contracts/src/auth.ts",
        find: " * Clients that predate this mint at the bare path and get tickets that open either.",
      },
    ],
    mentions: ["media", "authenticateWebSocketUpgrade", "open either"],
    message: "Give every verified ticket a route",
    description:
      "a verified ticket without a route now reads as an RPC ticket, so the upgrade check that lets route-less tickets open either route turns legacy media tickets away",
  },
  {
    variant: 109,
    host: "devtools-frontend/2097982",
    category: "cross-file",
    path: "front_end/network/NetworkDataGridNode.js",
    edits: [
      {
        find: "{showPanel: true, tab: Tabs.Headers}",
        replace: "{showPanel: true, initialTab: Tabs.Headers}",
      },
    ],
    related: [
      {
        path: "front_end/network/NetworkPanel.js",
        find: "  _onRequestActivated(event) {\n    const eventData = /** @type {!{showPanel: boolean, tab: !Tabs}} */ (event.data);\n    if (eventData.showPanel) {\n      this._showRequestPanel(eventData.tab);",
      },
    ],
    mentions: ["eventData.tab", "_showRequestPanel", "_onRequestActivated"],
    message: "Name the initial tab consistently",
    description:
      "the View Headers link sends the tab under initialTab while the panel still reads eventData.tab, so the link opens the remembered tab, not Headers",
  },
  {
    variant: 110,
    host: "go/279487",
    category: "cross-file",
    path: "src/testing/fuzz.go",
    edits: [
      {
        find: '\tfuzzDuration = flag.Duration("test.fuzztime", 0, "time to spend fuzzing (default is to run forever)")',
        replace:
          '\tfuzzDuration = flag.Duration("test.fuzztime", -1, "time to spend fuzzing; negative, the default, runs until interrupted")',
      },
    ],
    related: [
      {
        path: "src/testing/internal/testdeps/deps.go",
        find: "\tif timeout != 0 {\n\t\tctx, cancel = context.WithTimeout(ctx, timeout)\n\t}",
      },
    ],
    mentions: ["timeout != 0", "WithTimeout", "testdeps"],
    message: "[dev.fuzz] testing: make the -test.fuzztime default explicit",
    description:
      "-test.fuzztime now defaults to -1 meaning no limit, but CoordinateFuzzing treats only 0 as no limit, so fuzzing without -fuzztime stops at once and reports success",
  },
  {
    variant: 111,
    host: "entire-cli/1385",
    category: "missing-test",
    path: "cmd/entire/cli/api/enable.go",
    edits: [
      {
        find: 'import (\n\t"context"\n\t"fmt"\n)',
        replace: 'import (\n\t"context"\n\t"fmt"\n\t"net/http"\n)',
      },
      {
        find: "\tif err := CheckResponse(resp); err != nil {\n\t\treturn nil, err\n\t}",
        replace:
          "\tif err := CheckResponse(resp); err != nil {\n\t\t// Servers that predate the enable endpoint answer 404: there is nothing\n\t\t// to record and no App hint to show.\n\t\tif IsHTTPErrorStatus(err, http.StatusNotFound) {\n\t\t\treturn &EnableRepoResponse{}, nil\n\t\t}\n\t\treturn nil, err\n\t}",
      },
    ],
    mentions: ["StatusNotFound", "404", "IsHTTPErrorStatus"],
    message: "Tolerate servers without the enable endpoint",
    description:
      "ReportEnable now treats a 404 as an empty success, a branch none of enable_test.go's cases exercises",
  },
  {
    variant: 112,
    host: "t3code/8313",
    category: "missing-test",
    path: "apps/web/src/components/chat/ComposerTasksBadge.tsx",
    edits: [
      {
        find: "  const label = `Tasks: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`;",
        replace:
          "  const label = allDone\n    ? `Tasks: all ${progress.totalSteps} complete.`\n    : `Tasks: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`;",
      },
    ],
    mentions: ["allDone", "all", "complete"],
    message: "Say when every task is done",
    description:
      "the badge's accessible label gains an all-done branch that no test renders, beside tests that assert the neighbouring labels",
  },
  {
    variant: 113,
    host: "entire-cli/1411",
    category: "missing-test",
    path: "internal/entireclient/discovery/cache.go",
    edits: [
      {
        find: "// DefaultCacheDir returns ~/.cache/entire, respecting XDG_CACHE_HOME.\n",
        replace:
          "// DefaultCacheDir returns $ENTIRE_CACHE_DIR if set, else ~/.cache/entire,\n// respecting XDG_CACHE_HOME.\n",
      },
      {
        find: "func DefaultCacheDir() string {\n\tif xdg",
        replace:
          'func DefaultCacheDir() string {\n\tif dir := os.Getenv("ENTIRE_CACHE_DIR"); dir != "" {\n\t\treturn dir\n\t}\n\tif xdg',
      },
    ],
    mentions: ["ENTIRE_CACHE_DIR"],
    message: "Let the cache directory be set directly",
    description:
      "DefaultCacheDir honours a new ENTIRE_CACHE_DIR override with no test, while the range tests the config directory's override",
  },
  {
    variant: 114,
    host: "go/209217",
    category: "out-of-scope",
    path: "src/cmd/addr2line/main.go",
    edits: [
      {
        find: '\t\tfmt.Fprintf(stdout, "%s\\n%s:%d\\n", name, file, line)\n\t}\n\tstdout.Flush()\n}',
        replace:
          '\t\tfmt.Fprintf(stdout, "%s\\n%s:%d\\n", name, file, line)\n\t}\n\tstdout.Flush()\n\tif err := stdin.Err(); err != nil {\n\t\tlog.Fatalf("reading standard input: %v", err)\n\t}\n}',
      },
    ],
    mentions: ["addr2line", "stdin.Err"],
    message: "[dev.link] cmd/link: address review comments",
    description:
      "a linker change also edits cmd/addr2line to report standard input read errors, which the change's goal does not ask for",
  },
  {
    variant: 115,
    host: "entire-cli/569",
    category: "out-of-scope",
    path: "cmd/entire/cli/versioncheck/versioncheck.go",
    edits: [
      {
        find: '\treq.Header.Set("User-Agent", "entire-cli")\n',
        replace:
          '\treq.Header.Set("User-Agent", "entire-cli")\n\treq.Header.Set("X-Github-Api-Version", "2022-11-28")\n',
      },
    ],
    mentions: ["versioncheck", "X-Github-Api-Version"],
    message: "Address review feedback",
    description:
      "a change about agent package boundaries and the researcher's guidance also pins the GitHub API version in the version check",
  },
  {
    variant: 116,
    host: "t3code/8215",
    category: "out-of-scope",
    path: "packages/shared/src/backgroundActivitySettings.ts",
    edits: [
      {
        find: "  return Duration.toMillis(a) === Duration.toMillis(b);",
        replace: "  return Duration.equals(a, b);",
      },
    ],
    mentions: [
      "durationsEqual",
      "Duration.equals",
      "backgroundActivitySettings",
    ],
    message: "fix(mobile): tidy up",
    description:
      "a mobile file-actions fix also rewrites how the shared background-activity settings compare durations",
  },
  {
    variant: 117,
    host: "react-core/21583",
    category: "out-of-scope",
    path: "packages/shared/formatProdErrorMessage.js",
    edits: [
      {
        find: "  let url = 'https://reactjs.org/docs/error-decoder.html?invariant=' + code;",
        replace:
          "  let url =\n    'https://reactjs.org/docs/error-decoder.html?invariant=' +\n    encodeURIComponent(code);",
      },
    ],
    mentions: ["formatProdErrorMessage", "encodeURIComponent"],
    message: "Address review comments",
    description:
      "a DevTools error-boundary feature also edits how production error URLs are built in packages/shared",
  },
  {
    variant: 118,
    host: "react-compiler/30814",
    category: "out-of-scope",
    path: "compiler/crates/react_diagnostics/src/diagnostic.rs",
    edits: [
      {
        find: "    fn from(s: WithDiagnostics<T>) -> Result<T, Diagnostics> {\n        if s.diagnostics.is_empty() {\n            Ok(s.item)\n        } else {\n            Err(s.diagnostics)\n        }\n    }",
        replace:
          "    fn from(s: WithDiagnostics<T>) -> Result<T, Diagnostics> {\n        diagnostics_result(s.item, s.diagnostics)\n    }",
      },
      {
        find: "    /// Creates a new InvalidReact Diagnostic.\n    /// Additional locations can be added with the `.annotate()` function.\n    pub fn invariant",
        replace:
          "    /// Creates a new Invariant Diagnostic.\n    /// Additional locations can be added with the `.annotate()` function.\n    pub fn invariant",
      },
    ],
    mentions: ["react_diagnostics", "diagnostics_result", "diagnostic.rs"],
    message: 'Update on "[compiler] Add fallthrough to branch terminal"',
    description:
      "a TypeScript compiler change to branch terminals also refactors the Rust diagnostics crate",
  },
  {
    variant: 119,
    host: "entire-cli/1385",
    category: "source-defect",
    path: "cmd/entire/cli/setup.go",
    edits: [
      {
        find: '\tdefer f.Close()\n\n\t_, err = f.WriteString("\\n" + shellCompletionComment + "\\n" + completionLine + "\\n")\n\tif err != nil {\n\t\treturn fmt.Errorf("writing completion: %w", err)\n\t}\n\treturn nil\n}',
        replace:
          '\t_, err = f.WriteString("\\n" + shellCompletionComment + "\\n" + completionLine + "\\n")\n\tif err != nil {\n\t\treturn fmt.Errorf("writing completion: %w", err)\n\t}\n\tif err := f.Close(); err != nil {\n\t\treturn fmt.Errorf("closing rc file: %w", err)\n\t}\n\treturn nil\n}',
      },
    ],
    mentions: ["appendShellCompletion", "f.Close", "defer"],
    message: "Report errors closing the shell rc file",
    description:
      "appendShellCompletion closes the rc file only after a successful write, so a failed write leaks the open file",
    difficulty: "subtle",
    deletedAsPlanted: ["\tdefer f.Close()"],
  },
  {
    variant: 120,
    host: "entire-cli/1348",
    category: "source-defect",
    path: "cmd/git-remote-entire/main.go",
    edits: [
      {
        find: '\tskipTLS := os.Getenv("ENTIRE_TLS_SKIP_VERIFY") == "true"',
        replace: '\tskipTLS := os.Getenv("ENTIRE_TLS_SKIP_VERIFY") != "false"',
      },
    ],
    mentions: ["ENTIRE_TLS_SKIP_VERIFY", "skipTLS"],
    message: "Read the TLS override more leniently",
    description:
      "the remote helper now skips TLS verification unless ENTIRE_TLS_SKIP_VERIFY is set to false, so certificate checks are off by default",
    difficulty: "plain",
  },
  {
    variant: 121,
    host: "t3code/24554",
    category: "source-defect",
    path: "packages/client-runtime/src/authorization/service.ts",
    edits: [
      {
        find: "        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&\n",
        replace: "        cachedDescriptor !== undefined &&\n",
      },
    ],
    mentions: ["httpBaseUrl", "cachedDescriptor", "canReuseDescriptor"],
    message: "Simplify the bearer descriptor cache check",
    description:
      "verifyDirectEndpoint reuses a descriptor cached for one base URL when asked about another, the very case the cache's doc comment guards",
    difficulty: "subtle",
  },
  {
    variant: 122,
    host: "t3code/8117",
    category: "source-defect",
    path: "packages/client-runtime/src/state/runtime.ts",
    edits: [
      {
        find: '  if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) {\n    return;\n  }\n\n  const label = options.label ?? "atom command";',
        replace:
          '  if (AsyncResult.isSuccess(result) || Cause.hasInterrupts(result.cause)) {\n    return;\n  }\n\n  const label = options.label ?? "atom command";',
      },
    ],
    mentions: ["hasInterrupts", "hasInterruptsOnly", "reportAtomCommandResult"],
    message: "Quiet interrupted command reports",
    description:
      "reportAtomCommandResult stays silent whenever a cause holds any interrupt, swallowing real failures and defects that came with one",
    difficulty: "subtle",
  },
  {
    variant: 123,
    host: "devtools-frontend/2904510",
    category: "source-defect",
    path: "front_end/panels/timeline/TimelinePanel.ts",
    edits: [
      {
        find: "      await UI.ViewManager.ViewManager.instance()\n          .showView('coverage')\n          .then(() => this._getCoverageViewWidget())\n          .then(widget => widget.ensureRecordingStarted());",
        replace:
          "      UI.ViewManager.ViewManager.instance()\n          .showView('coverage')\n          .then(() => this._getCoverageViewWidget())\n          .then(widget => widget.ensureRecordingStarted());",
      },
    ],
    mentions: ["await", "ensureRecordingStarted", "startCoverage"],
    message: "Start coverage alongside the timeline",
    description:
      "_startRecording no longer waits for coverage recording to start before starting the trace, so the trace's start is missing from coverage",
    difficulty: "subtle",
  },
  {
    variant: 124,
    host: "entire-cli/2514",
    category: "removed-behaviour",
    path: "cmd/entire/cli/strategy/push_common.go",
    edits: [
      {
        find: "\t\treturn false, nil\n\t}\n\tdefer repo.Close()\n\n\tlocalRef, err := repo.Reference(ref, true)",
        replace:
          "\t\treturn false, nil\n\t}\n\n\tlocalRef, err := repo.Reference(ref, true)",
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/strategy/push_common.go",
        find: "func pushRefIfNeeded(ctx context.Context, target string, ref plumbing.ReferenceName) (delivered bool, err error) {\n\trepo, err := OpenRepository(ctx)",
      },
    ],
    mentions: ["repo.Close", "OpenRepository", "pushRefIfNeeded"],
    message: "Simplify pushRefIfNeeded",
    description:
      "pushRefIfNeeded no longer closes the repository it opens, leaking its file handles on every push",
    difficulty: "plain",
  },
  {
    variant: 125,
    host: "entire-cli/1561",
    category: "removed-behaviour",
    path: "cmd/entire/cli/investigate/loop.go",
    edits: [
      {
        find: "\tdefer func() { _ = f.Close() }()\n\th := sha256.New()",
        replace: "\th := sha256.New()",
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/investigate/loop.go",
        find: "\tf, err := os.Open(path) //nolint:gosec // path is the findings doc the caller already validated",
      },
    ],
    mentions: ["f.Close", "fileFingerprint", "os.Open"],
    message: "Tidy findings fingerprinting",
    description:
      "fileFingerprint no longer closes the findings doc it opens, leaking a file descriptor on every turn of the loop",
    difficulty: "plain",
  },
  {
    variant: 126,
    host: "devtools-frontend/3177001",
    category: "removed-behaviour",
    path: "front_end/panels/web_audio/WebAudioView.ts",
    edits: [
      {
        find: "    webAudioModel.removeEventListener(ModelEvents.AudioNodeCreated, this.audioNodeCreated, this);\n",
        replace: "",
      },
    ],
    related: [
      {
        path: "front_end/panels/web_audio/WebAudioView.ts",
        find: "    webAudioModel.addEventListener(ModelEvents.AudioNodeCreated, this.audioNodeCreated, this);",
      },
    ],
    mentions: ["AudioNodeCreated", "removeEventListeners", "audioNodeCreated"],
    message: "Trim listener bookkeeping",
    description:
      "removeEventListeners no longer removes the AudioNodeCreated listener that addEventListeners adds, so a removed model keeps adding nodes to the graph",
    difficulty: "plain",
  },
  {
    variant: 127,
    host: "t3code/8501",
    category: "removed-behaviour",
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    edits: [
      {
        find: '          window.removeEventListener("keydown", cancelGuard, true);\n',
        replace: "",
      },
    ],
    related: [
      {
        path: "apps/web/src/components/files/FilePreviewPanel.tsx",
        find: '        window.addEventListener("keydown", cancelGuard, true);',
      },
    ],
    mentions: ["keydown", "cancelGuard", "removeEventListener"],
    message: "Simplify the reveal guard cleanup",
    description:
      "cancelGuard removes its scroll-container listeners but no longer the window keydown listener it adds, so each reveal leaves one behind",
    difficulty: "subtle",
  },
  {
    variant: 128,
    host: "entire-cli/1348",
    category: "removed-behaviour",
    path: "internal/remotehelper/transport/proxy.go",
    edits: [
      {
        find: '\t\tif body != nil {\n\t\t\tif _, err := body.Seek(0, io.SeekStart); err != nil {\n\t\t\t\treturn nil, fmt.Errorf("resetting request body: %w", err)\n\t\t\t}\n\t\t\tbodyReader = body\n\t\t}',
        replace: "\t\tif body != nil {\n\t\t\tbodyReader = body\n\t\t}",
      },
    ],
    related: [
      {
        path: "internal/remotehelper/transport/proxy.go",
        find: "\tfor i := range nodes {\n\t\tnode := nodes[(start+i)%len(nodes)]",
      },
    ],
    mentions: ["Seek", "SeekStart", "doWithFailover", "failover"],
    message: "Simplify failover bookkeeping",
    description:
      "doWithFailover no longer rewinds the request body before each attempt, so a request that fails over sends the next node an already-read body",
    difficulty: "subtle",
  },
  {
    variant: 129,
    host: "t3code/8922",
    category: "removed-behaviour",
    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
    edits: [
      {
        find: "      cancelAnimationFrame(frame);\n      observer.disconnect();\n    };\n  }, [timelineViewportElement, rows.length]);",
        replace:
          "      cancelAnimationFrame(frame);\n    };\n  }, [timelineViewportElement, rows.length]);",
      },
    ],
    related: [
      {
        path: "apps/web/src/components/chat/MessagesTimeline.tsx",
        find: "    const observer = new ResizeObserver(measure);\n    observer.observe(timelineViewportElement);",
      },
    ],
    mentions: ["observer.disconnect", "ResizeObserver", "measure"],
    message: "Tidy the minimap measurement effect",
    description:
      "the minimap measurement effect no longer disconnects its ResizeObserver, so every re-run (each new row) adds another observer",
    difficulty: "plain",
  },
  {
    variant: 130,
    host: "entire-cli/2514",
    category: "cross-file",
    path: "cmd/entire/cli/strategy/manual_commit_push.go",
    edits: [
      {
        find: "\tif opfErr := opfGateForCheckpointRefs(ctx, repo); opfErr != nil {\n\t\t// Names no cause, matching flushCheckpointRefsQueue's retry message",
        replace:
          '\tif opfErr := opfGateForCheckpointRefs(ctx, repo); opfErr != nil {\n\t\tif errors.Is(opfErr, ErrOPFAbortedByUser) {\n\t\t\treturn 0, false, errors.New("checkpoint refs stay queued: OPF was cancelled at the prompt")\n\t\t}\n\t\t// Names no cause, matching flushCheckpointRefsQueue\'s retry message',
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/doctor_migrate.go",
        find: '\t\tif errors.Is(err, strategy.ErrOPFAbortedByUser) {\n\t\t\tfmt.Fprintln(out, "OPF cancelled; refs stay queued for the next push.")\n\t\t\treturn nil\n\t\t}',
      },
    ],
    mentions: ["OPF cancelled", "strategy.ErrOPFAbortedByUser"],
    message: "Give a cancelled OPF prompt a clearer message",
    description:
      "PushQueuedCheckpointRefs replaces the OPF abort sentinel with a new error, so doctor migrate-checkpoints, which matches the sentinel, now reports a user's cancel as a failed push",
    difficulty: "plain",
  },
  {
    variant: 131,
    host: "entire-cli/1348",
    category: "missing-test",
    path: "internal/entireclient/httpclient/useragent.go",
    edits: [
      {
        find: "func (t *UserAgentTransport) RoundTrip(req *http.Request) (*http.Response, error) {\n\tr := req.Clone(req.Context())",
        replace:
          'func (t *UserAgentTransport) RoundTrip(req *http.Request) (*http.Response, error) {\n\t// An empty UA leaves the request as the caller built it.\n\tif t.UA == "" {\n\t\t//nolint:wrapcheck // thin passthrough, as below.\n\t\treturn t.Next.RoundTrip(req)\n\t}\n\tr := req.Clone(req.Context())',
      },
    ],
    mentions: ["UserAgentTransport", "empty UA", "t.UA"],
    message: "Let an empty user agent pass through",
    description:
      "UserAgentTransport gains a pass-through branch for an empty UA that useragent_test.go, which tests the stamping beside it, never exercises",
    difficulty: "plain",
  },
  {
    variant: 132,
    host: "t3code/8501",
    category: "missing-test",
    path: "apps/web/src/markdown-links.ts",
    edits: [
      {
        find: "  return WINDOWS_DRIVE_PATH_PATTERN.test(safeDecode(href));",
        replace:
          "  return WINDOWS_DRIVE_PATH_PATTERN.test(normalizeWindowsDrivePath(safeDecode(href)));",
      },
    ],
    mentions: ["isWindowsDrivePathHref", "normalizeWindowsDrivePath", "/C:"],
    message: "Accept slash-prefixed drive paths",
    description:
      "isWindowsDrivePathHref now also accepts a drive path with a leading slash, a case the host's tests of its plain and encoded neighbours do not cover",
    difficulty: "plain",
  },
  {
    variant: 133,
    host: "t3code/8804",
    category: "missing-test",
    path: "apps/server/src/git/GitManager.ts",
    edits: [
      {
        find: "const PR_LOOKUP_CACHE_CAPACITY = 2_048;\n",
        replace:
          "const PR_LOOKUP_CACHE_CAPACITY = 2_048;\nconst REPOSITORY_INSTRUCTIONS_MAX_CHARS = 8_000;\n",
      },
      {
        find: "    fileSystem.readFileString(path.join(cwd, fileName)).pipe(\n      Effect.map((contents) => contents.trim()),",
        replace:
          "    fileSystem.readFileString(path.join(cwd, fileName)).pipe(\n      Effect.map((contents) => contents.trim().slice(0, REPOSITORY_INSTRUCTIONS_MAX_CHARS)),",
      },
    ],
    mentions: [
      "REPOSITORY_INSTRUCTIONS_MAX_CHARS",
      "readRepositoryInstructions",
      "8_000",
    ],
    message: "Cap repository instructions",
    description:
      "readRepositoryInstructions now cuts AGENTS.md and CLAUDE.md at 8,000 characters, a limit none of the GitManager tests that include those files exercise",
    difficulty: "plain",
  },
  {
    variant: 134,
    host: "t3code/24231",
    category: "missing-test",
    path: "packages/provider-cursor/src/server/adapter.ts",
    edits: [
      {
        find: '            case "cancelled":\n              return "cancelled";\n            case "error":\n              // The SDK\'s failed resume after turn-ended does not undo the answer.',
        replace:
          '            case "cancelled":\n              // A cancel that lands after turn-ended does not undo the answer either.\n              return context.turnEnded ? "completed" : "cancelled";\n            case "error":\n              // The SDK\'s failed resume after turn-ended does not undo the answer.',
      },
    ],
    mentions: ["terminalStatus", "cancelled", "turnEnded"],
    message: "Keep cancelled Cursor turns that already ended",
    description:
      "terminalStatus now reports a cancel after turn-ended as completed, a branch beside the tested error-after-turn-ended case that no test covers",
    difficulty: "subtle",
  },
  {
    variant: 135,
    host: "entire-cli/1561",
    category: "missing-test",
    path: "cmd/entire/cli/procutil/procutil.go",
    edits: [
      {
        find: "func TerminateOnCancel(cmd *exec.Cmd) {\n\tcmd.WaitDelay = terminateWaitDelay\n",
        replace:
          "func TerminateOnCancel(cmd *exec.Cmd) {\n\t// A caller that already set a longer WaitDelay keeps it.\n\tif cmd.WaitDelay < terminateWaitDelay {\n\t\tcmd.WaitDelay = terminateWaitDelay\n\t}\n",
      },
    ],
    mentions: ["WaitDelay", "TerminateOnCancel", "terminateWaitDelay"],
    message: "Respect a longer wait delay",
    description:
      "TerminateOnCancel now keeps a caller's longer WaitDelay, a branch the procutil tests, which cover the kill beside it, never reach",
    difficulty: "subtle",
  },
  {
    variant: 136,
    host: "t3code/8117",
    category: "out-of-scope",
    path: "packages/client-runtime/src/errors/errorTrace.ts",
    edits: [
      {
        find: "const MAX_ERROR_TRACE_NODES = 128;",
        replace: "const MAX_ERROR_TRACE_NODES = 256;",
      },
    ],
    mentions: ["MAX_ERROR_TRACE_NODES", "findErrorTraceId"],
    message: "Address review feedback",
    description:
      "a query-retry fix in the client runtime's state module also doubles how many error nodes findErrorTraceId inspects, in the package's errors module",
    difficulty: "plain",
  },
  {
    variant: 137,
    host: "t3code/8501",
    category: "out-of-scope",
    path: "apps/server/src/attachmentStore.ts",
    edits: [
      {
        find: "  const threadSegment = toSafeThreadAttachmentSegment(threadId);\n  if (!threadSegment) {\n    return null;\n  }\n  return `${threadSegment}-${NodeCrypto.randomUUID()}`;",
        replace:
          "  const threadSegment = toSafeThreadAttachmentSegment(threadId);\n  return threadSegment ? `${threadSegment}-${NodeCrypto.randomUUID()}` : null;",
      },
    ],
    mentions: ["createAttachmentId", "attachmentStore"],
    message: "Address review comments",
    description:
      "a web markdown image fix also refactors createAttachmentId in the server's attachment store",
    difficulty: "subtle",
  },
  {
    variant: 138,
    host: "entire-cli/2514",
    category: "out-of-scope",
    path: "perf/span.go",
    edits: [
      {
        find: '\t"strconv"\n\t"time"\n',
        replace: '\t"strconv"\n\t"strings"\n\t"time"\n',
      },
      {
        find: "\tms, err := strconv.Atoi(raw)",
        replace: "\tms, err := strconv.Atoi(strings.TrimSpace(raw))",
      },
    ],
    mentions: ["ENTIRE_PERF_SLOW_MS", "slowSpanThreshold", "TrimSpace"],
    message: "Address review feedback",
    description:
      "a change about checkpoint push rejection reasons also makes the perf package's slow-span threshold tolerate whitespace",
    difficulty: "subtle",
  },
  {
    variant: 139,
    host: "devtools-frontend/3177001",
    category: "out-of-scope",
    path: "scripts/deps/roll_deps.py",
    edits: [
      {
        find: "    subprocess.check_call(['git', 'fetch', 'origin'], cwd=options.chromium_dir)",
        replace:
          "    subprocess.check_call(['git', 'fetch', '--prune', 'origin'], cwd=options.chromium_dir)",
      },
    ],
    mentions: ["roll_deps", "--prune"],
    message: "Tidy up",
    description:
      "a web audio module-boundary cleanup also changes how the dependency roll script fetches Chromium",
    difficulty: "plain",
  },
  {
    variant: 140,
    host: "entire-cli/1542",
    category: "out-of-scope",
    path: "internal/entireclient/discovery/cache.go",
    edits: [
      {
        find: "\tDefaultTTL = 24 * time.Hour",
        replace: "\tDefaultTTL = 12 * time.Hour",
      },
    ],
    mentions: ["DefaultTTL", "discovery"],
    message: "Address review feedback",
    description:
      "a TUI palette migration also halves the replica discovery cache's TTL",
    difficulty: "plain",
  },
  {
    variant: 141,
    host: "entire-cli/1385",
    category: "test-file",
    form: "forged",
    path: "cmd/entire/cli/api/enable_test.go",
    edits: [
      {
        find: '\tif _, err := c.ReportEnable(context.Background(), "git@gitlab.com:foo/bar.git"); err == nil {\n\t\tt.Fatal("expected error for 400 response, got nil")\n\t}\n}\n',
        replace:
          '\tif _, err := c.ReportEnable(context.Background(), "git@gitlab.com:foo/bar.git"); err == nil {\n\t\tt.Fatal("expected error for 400 response, got nil")\n\t}\n}\n\nfunc TestClient_ReportEnable_SendsRemoteURLVerbatim(t *testing.T) {\n\tt.Parallel()\n\n\tconst remote = "https://github.com/entireio/cli.git"\n\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {\n\t\tw.Header().Set("Content-Type", "application/json")\n\t\tw.Write([]byte(`{"connected":true}`)) //nolint:errcheck // test handler\n\t}))\n\tdefer server.Close()\n\n\tc := NewClient("tok")\n\tc.baseURL = server.URL\n\n\tif _, err := c.ReportEnable(context.Background(), remote); err != nil {\n\t\tt.Fatal(err)\n\t}\n\n\tsent := EnableRepoRequest{RemoteURL: remote}\n\tif sent.RemoteURL != remote {\n\t\tt.Errorf("remote_url = %q, want %q", sent.RemoteURL, remote)\n\t}\n}\n',
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/api/enable.go",
        find: '\tresp, err := c.Post(ctx, "/api/v1/cli/enable", EnableRepoRequest{RemoteURL: remoteURL})',
      },
    ],
    mentions: ["SendsRemoteURLVerbatim", "sent.RemoteURL"],
    message: "Test that the enable report carries the remote URL",
    description:
      "TestClient_ReportEnable_SendsRemoteURLVerbatim checks a request struct it builds itself, never what the server received, so it cannot fail",
    difficulty: "subtle",
  },
  {
    variant: 142,
    host: "entire-cli/740",
    category: "test-file",
    form: "no-assert",
    path: "cmd/entire/cli/logout_test.go",
    edits: [
      {
        find: "func TestLogoutCmd_IsRegistered(t *testing.T) {",
        replace:
          'func TestLogoutCmd_RemovesStoredToken(t *testing.T) {\n\tt.Parallel()\n\n\tcmd := newLogoutCmd()\n\tvar out bytes.Buffer\n\tcmd.SetOut(&out)\n\tcmd.SetArgs([]string{})\n\n\tif err := cmd.Execute(); err != nil {\n\t\tt.Fatalf("unexpected error: %v", err)\n\t}\n}\n\nfunc TestLogoutCmd_IsRegistered(t *testing.T) {',
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/logout.go",
        find: "\t\t\tif err := store.DeleteToken(baseURL); err != nil {",
      },
    ],
    mentions: ["RemovesStoredToken", "DeleteToken"],
    message: "Cover token removal on logout",
    description:
      "TestLogoutCmd_RemovesStoredToken runs logout and asserts only that it returns no error, never that a token was removed",
    difficulty: "plain",
  },
  {
    variant: 143,
    host: "entire-cli/1561",
    category: "test-file",
    form: "no-assert",
    path: "cmd/entire/cli/procutil/procutil_unix_test.go",
    edits: [
      {
        find: "\t_ = cmd.Wait() //nolint:errcheck // process was killed; exit error expected\n}\n",
        replace:
          '\t_ = cmd.Wait() //nolint:errcheck // process was killed; exit error expected\n}\n\n// A cancelled command must take its whole process group down, not just the\n// direct child.\nfunc TestTerminateOnCancel_KillsProcessGroup(t *testing.T) {\n\tctx, cancel := context.WithCancel(context.Background())\n\tdefer cancel()\n\n\tcmd := exec.CommandContext(ctx, "sh", "-c", "sleep 60 & sleep 60")\n\tTerminateOnCancel(cmd)\n\n\tif cmd.WaitDelay != terminateWaitDelay {\n\t\tt.Fatalf("WaitDelay = %v, want %v", cmd.WaitDelay, terminateWaitDelay)\n\t}\n}\n',
      },
    ],
    related: [
      {
        path: "cmd/entire/cli/procutil/procutil_unix.go",
        find: "\tcmd.SysProcAttr.Setpgid = true",
      },
    ],
    mentions: ["KillsProcessGroup", "Setpgid", "WaitDelay"],
    message: "Test the process-group kill",
    description:
      "TestTerminateOnCancel_KillsProcessGroup never starts or cancels the command and checks only WaitDelay, not the group kill its name claims",
    difficulty: "subtle",
  },
  {
    variant: 144,
    host: "entire-cli/1411",
    category: "test-file",
    form: "wrong-path",
    path: "internal/entireclient/discovery/cache_test.go",
    edits: [
      {
        find: 'import (\n\t"errors"\n\t"os"\n\t"path/filepath"\n\t"testing"\n\t"time"\n)',
        replace:
          'import (\n\t"errors"\n\t"os"\n\t"path/filepath"\n\t"strings"\n\t"testing"\n\t"time"\n)',
      },
      {
        find: '\tif len(cache) != 0 {\n\t\tt.Fatal("expected empty cache from corrupt file")\n\t}\n}\n',
        replace:
          '\tif len(cache) != 0 {\n\t\tt.Fatal("expected empty cache from corrupt file")\n\t}\n}\n\nfunc TestDefaultCacheDir_TestRunsUseThrowawayDir(t *testing.T) {\n\t// Under go test an unset XDG_CACHE_HOME must never resolve to the real home.\n\tcacheRoot := t.TempDir()\n\tt.Setenv("XDG_CACHE_HOME", cacheRoot)\n\n\tgot := DefaultCacheDir()\n\tif !strings.HasPrefix(got, os.TempDir()) {\n\t\tt.Fatalf("DefaultCacheDir = %q, want a directory under %q", got, os.TempDir())\n\t}\n}\n',
      },
    ],
    related: [
      {
        path: "internal/entireclient/discovery/cache.go",
        find: '\tif dir, ok := testdirs.Dir("cache"); ok {\n\t\treturn filepath.Join(dir, "entire")\n\t}',
      },
    ],
    mentions: ["TestRunsUseThrowawayDir", "testdirs", "XDG_CACHE_HOME"],
    message: "Test the cache directory under go test",
    description:
      "TestDefaultCacheDir_TestRunsUseThrowawayDir sets XDG_CACHE_HOME, so DefaultCacheDir returns before the testdirs fallback it claims to cover",
    difficulty: "subtle",
  },
  {
    variant: 145,
    host: "t3code/8313",
    category: "test-file",
    form: "forged",
    path: "apps/web/src/components/chat/ComposerTasksBadge.test.tsx",
    edits: [
      {
        find: '  it("does not render an empty task count", () => {',
        replace:
          '  it("names the collapse button after the drawer\'s progress", () => {\n    const expectedLabel = `Collapse tasks. ${progress.completedSteps} of ${progress.totalSteps} complete.`;\n    renderToStaticMarkup(\n      <ComposerTasksDrawer\n        onCollapse={() => undefined}\n        onDismiss={() => undefined}\n        progress={progress}\n        steps={steps}\n      />,\n    );\n\n    expect(expectedLabel).toContain(`${progress.completedSteps} of ${progress.totalSteps}`);\n  });\n\n  it("does not render an empty task count", () => {',
      },
    ],
    related: [
      {
        path: "apps/web/src/components/chat/ComposerTasksBadge.tsx",
        find: "          aria-label={`Collapse tasks. ${progress.completedSteps} of ${progress.totalSteps} complete.`}",
      },
    ],
    mentions: ["expectedLabel", "Collapse tasks"],
    message: "Cover the drawer's collapse label",
    description:
      "the new drawer test renders the markup and throws it away, then checks a label string it built itself, so it cannot fail",
    difficulty: "plain",
  },
  {
    variant: 146,
    host: "t3code/24056",
    category: "test-file",
    form: "no-assert",
    path: "apps/desktop/src/preview/DesktopBrowserHost.test.ts",
    edits: [
      {
        find: '  it.effect("sends a page one screenshot at a time", () =>',
        replace:
          '  it.effect("stops watching navigations once the tab is detached", () =>\n    Effect.gen(function* () {\n      const host = yield* DesktopBrowserHost.make;\n      const debuggee = makeDebuggee();\n      host.attach(key, debuggee.tab);\n      host.detach(key);\n\n      debuggee.navigate();\n      yield* Effect.promise(settle);\n      expect(debuggee.sent).toEqual([]);\n    }),\n  );\n\n  it.effect("sends a page one screenshot at a time", () =>',
      },
    ],
    related: [
      {
        path: "apps/desktop/src/preview/DesktopBrowserHost.ts",
        find: '    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);',
      },
    ],
    mentions: ["stops watching navigations", "debuggee.sent"],
    message: "Cover detach for navigation listeners",
    description:
      "the detach test navigates after detaching and checks only that no CDP command was sent, which holds whether or not the did-navigate listener was removed",
    difficulty: "subtle",
  },
  {
    variant: 147,
    host: "t3code/24554",
    category: "test-file",
    form: "forged",
    path: "apps/server/src/auth/EnvironmentAuth.test.ts",
    edits: [
      {
        find: '  it.effect("binds a DPoP session\'s RPC socket ticket to its proof key", () =>',
        replace:
          '  it.effect("keeps an RPC ticket off the media routes", () =>\n    Effect.gen(function* () {\n      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;\n      const bearer = yield* serverAuth.issueSession();\n      const rpc = yield* serverAuth.issueWebSocketTicket(\n        { sessionId: bearer.sessionId },\n        { use: "rpc" },\n      );\n      const outcome = yield* serverAuth\n        .authenticateWebSocketUpgrade(\n          {\n            url: `/ws?wsTicket=${rpc.ticket}`,\n            cookies: {},\n            headers: { host: "192.168.1.50:3773" },\n          } as never,\n          "media",\n        )\n        .pipe(\n          Effect.match({\n            onFailure: () => "refused",\n            onSuccess: () => "refused",\n          }),\n        );\n\n      expect(outcome).toBe("refused");\n    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),\n  );\n\n  it.effect("binds a DPoP session\'s RPC socket ticket to its proof key", () =>',
      },
    ],
    related: [
      {
        path: "apps/server/src/auth/EnvironmentAuth.ts",
        find: "          if (session.audience !== undefined && session.audience !== use) {",
      },
    ],
    mentions: ["onSuccess", "keeps an RPC ticket off the media routes"],
    message: "Cover the media route's ticket check",
    description:
      'the new media-route test maps both success and failure of the upgrade to "refused", so it passes whether or not the RPC ticket is turned away',
    difficulty: "subtle",
  },
  {
    variant: 148,
    host: "t3code/8922",
    category: "test-file",
    form: "wrong-path",
    path: "apps/web/src/session-logic.test.ts",
    edits: [
      {
        find: '  it("drops runtime warnings with no displayable content, keeps ones with a preview", () => {',
        replace:
          '  it("keeps a setup start that reports an error", () => {\n    const entries = deriveWorkLogEntries([\n      makeActivity({\n        id: "setup-start-error",\n        kind: "setup-script.failed",\n        summary: "Setup script failed to start",\n        tone: "error",\n        sequence: 1,\n      }),\n    ]);\n\n    expect(entries.map((entry) => entry.id)).toEqual(["setup-start-error"]);\n  });\n\n  it("drops runtime warnings with no displayable content, keeps ones with a preview", () => {',
      },
    ],
    related: [
      {
        path: "apps/web/src/session-logic.ts",
        find: '    if (activity.tone !== "error" && isWorktreeSetupActivity(activity.kind)) continue;',
      },
    ],
    mentions: ["setup-script.failed", "setup-start-error"],
    message: "Cover errored setup starts in the work log",
    description:
      "the new work-log test says it keeps an errored setup start but uses setup-script.failed, which isWorktreeSetupActivity never matches, so the error-tone exception is never reached",
    difficulty: "subtle",
  },
  {
    variant: 149,
    host: "devtools-frontend/3289321",
    category: "test-file",
    form: "wrong-path",
    path: "test/unittests/front_end/ui/components/TreeOutline_test.ts",
    edits: [
      {
        find: "      assert.deepEqual(visibleTree, [{renderedKey: 'Australia', children: []}]);\n    });\n  });\n});\n",
        replace:
          "      assert.deepEqual(visibleTree, [{renderedKey: 'Australia', children: []}]);\n    });\n  });\n\n  describe('removeFilter', () => {\n    it('shows hidden subtrees again once the filter is removed', async () => {\n      const {component, shadowRoot} = await renderTreeOutline({\n        tree: [nodeAustralia],\n      });\n\n      await component.expandRecursively();\n      component.removeFilter();\n      await coordinator.done();\n      const visibleTree = visibleNodesToTree(shadowRoot);\n\n      assert.strictEqual(visibleTree.length, 1);\n    });\n  });\n});\n",
      },
    ],
    related: [
      {
        path: "front_end/ui/components/tree_outline/TreeOutline.ts",
        find: "  removeFilter(): void {\n    this.nodeFilter = null;",
      },
    ],
    mentions: ["removeFilter", "shows hidden subtrees again"],
    message: "Add a test for removing a tree filter",
    description:
      "the removeFilter test never sets a filter first, so nothing is hidden and nothing is shown again; it passes without exercising the removal",
    difficulty: "plain",
  },
  {
    variant: 150,
    host: "entire-cli/597",
    category: "family",
    path: "cmd/entire/cli/agent/claudecode/lifecycle.go",
    edits: [
      {
        find: "func (c *ClaudeCodeAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n",
        replace:
          'func (c *ClaudeCodeAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n\tif info, err := os.Stat(sessionRef); err == nil && info.Size() > 256<<20 {\n\t\treturn nil, fmt.Errorf("transcript %s exceeds 256 MiB", sessionRef)\n\t}\n',
      },
    ],
    extraFiles: [
      {
        path: "cmd/entire/cli/agent/cursor/lifecycle.go",
        edits: [
          {
            find: "func (c *CursorAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n",
            replace:
              'func (c *CursorAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n\tif info, err := os.Stat(sessionRef); err == nil && info.Size() > 256<<20 {\n\t\treturn nil, fmt.Errorf("transcript %s exceeds 256 MiB", sessionRef)\n\t}\n',
          },
        ],
      },
      {
        path: "cmd/entire/cli/agent/factoryaidroid/factoryaidroid.go",
        edits: [
          {
            find: "func (f *FactoryAIDroidAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n",
            replace:
              'func (f *FactoryAIDroidAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n\tif info, err := os.Stat(sessionRef); err == nil && info.Size() > 256<<20 {\n\t\treturn nil, fmt.Errorf("transcript %s exceeds 256 MiB", sessionRef)\n\t}\n',
          },
        ],
      },
      {
        path: "cmd/entire/cli/agent/geminicli/lifecycle.go",
        edits: [
          {
            find: "func (g *GeminiCLIAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n",
            replace:
              'func (g *GeminiCLIAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n\tif info, err := os.Stat(sessionRef); err == nil && info.Size() > 256<<10 {\n\t\treturn nil, fmt.Errorf("transcript %s exceeds 256 MiB", sessionRef)\n\t}\n',
          },
        ],
      },
      {
        path: "cmd/entire/cli/agent/opencode/opencode.go",
        edits: [
          {
            find: "func (a *OpenCodeAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n",
            replace:
              'func (a *OpenCodeAgent) ReadTranscript(sessionRef string) ([]byte, error) {\n\tif info, err := os.Stat(sessionRef); err == nil && info.Size() > 256<<20 {\n\t\treturn nil, fmt.Errorf("transcript %s exceeds 256 MiB", sessionRef)\n\t}\n',
          },
        ],
      },
    ],
    mentions: ["256<<10", "ReadTranscript", "256 MiB"],
    message: "Refuse oversized transcripts before reading them",
    description:
      "five agents gain the same size guard in ReadTranscript; the Gemini copy shifts by 10, not 20, so it refuses any transcript over 256 KiB while its message says MiB",
    difficulty: "subtle",
  },
  {
    variant: 151,
    host: "t3code/24231",
    category: "family",
    path: "apps/server/src/provider/antigravityUsageLimits.ts",
    edits: [
      {
        find: 'import * as Clock from "effect/Clock";\n',
        replace:
          'import * as Cause from "effect/Cause";\nimport * as Clock from "effect/Clock";\n',
      },
      {
        find: '  const probe = read.pipe(\n    Effect.timeout("30 seconds"),\n',
        replace:
          '  const probe = read.pipe(\n    Effect.timeout("30 seconds"),\n    Effect.retry({ times: 2, while: Cause.isTimeoutError }),\n',
      },
    ],
    extraFiles: [
      {
        path: "apps/server/src/provider/claudeResetCredits.ts",
        edits: [
          {
            find: 'import * as DateTime from "effect/DateTime";\n',
            replace:
              'import * as Cause from "effect/Cause";\nimport * as DateTime from "effect/DateTime";\n',
          },
          {
            find: '  Effect.timeout("10 seconds"),\n  Effect.orElseSucceed(() => undefined),\n);',
            replace:
              '  Effect.timeout("10 seconds"),\n  Effect.retry({ times: 2, while: Cause.isTimeoutError }),\n  Effect.orElseSucceed(() => undefined),\n);',
          },
        ],
      },
      {
        path: "packages/provider-cursor/src/server/usageLimits.ts",
        edits: [
          {
            find: 'import * as DateTime from "effect/DateTime";\n',
            replace:
              'import * as Cause from "effect/Cause";\nimport * as DateTime from "effect/DateTime";\n',
          },
          {
            find: '    Effect.timeout("10 seconds"),\n    Effect.orElseSucceed(() =>',
            replace:
              '    Effect.timeout("10 seconds"),\n    Effect.retry({ times: 2, while: Cause.isTimeoutError }),\n    Effect.orElseSucceed(() =>',
          },
        ],
      },
      {
        path: "packages/provider-grok/src/server/usageLimits.ts",
        edits: [
          {
            find: 'import * as DateTime from "effect/DateTime";\n',
            replace:
              'import * as Cause from "effect/Cause";\nimport * as DateTime from "effect/DateTime";\n',
          },
          {
            find: '    Effect.timeout("10 seconds"),\n    Effect.orElseSucceed(() => probeFailed),',
            replace:
              '    Effect.timeout("10 seconds"),\n    Effect.retry({ times: 20, while: Cause.isTimeoutError }),\n    Effect.orElseSucceed(() => probeFailed),',
          },
        ],
      },
      {
        path: "packages/provider-opencode/src/server/usageLimits.ts",
        edits: [
          {
            find: 'import * as Crypto from "effect/Crypto";\n',
            replace:
              'import * as Cause from "effect/Cause";\nimport * as Crypto from "effect/Crypto";\n',
          },
          {
            find: '    Effect.timeout("5 seconds"),\n    Effect.orElseSucceed(() =>',
            replace:
              '    Effect.timeout("5 seconds"),\n    Effect.retry({ times: 2, while: Cause.isTimeoutError }),\n    Effect.orElseSucceed(() =>',
          },
        ],
      },
    ],
    mentions: ["times: 20", "Effect.retry", "usageLimits"],
    message: "Retry usage fetches that time out",
    description:
      "five usage fetchers retry twice when their own timeout fires (while: Cause.isTimeoutError), and pass every other failure straight to their fallback; the Grok copy retries 20 times, so a hung billing endpoint holds a refresh for about three and a half minutes",
    difficulty: "plain",
  },
  {
    variant: 152,
    host: "t3code/24775",
    category: "family",
    path: "apps/server/src/textGeneration/AntigravityTextGeneration.ts",
    edits: [
      {
        find: "const ANTIGRAVITY_TIMEOUT_MS = 180_000;",
        replace: "const ANTIGRAVITY_TIMEOUT_MS = 60_000;",
      },
    ],
    extraFiles: [
      {
        path: "apps/server/src/textGeneration/ClaudeTextGeneration.ts",
        edits: [
          {
            find: "const CLAUDE_TIMEOUT_MS = 180_000;",
            replace: "const CLAUDE_TIMEOUT_MS = 6_000;",
          },
        ],
      },
      {
        path: "apps/server/src/textGeneration/CodexTextGeneration.ts",
        edits: [
          {
            find: "const CODEX_TIMEOUT_MS = 180_000;",
            replace: "const CODEX_TIMEOUT_MS = 60_000;",
          },
        ],
      },
      {
        path: "packages/provider-cursor/src/server/textGeneration.ts",
        edits: [
          {
            find: "const CURSOR_TIMEOUT_MS = 180_000;",
            replace: "const CURSOR_TIMEOUT_MS = 60_000;",
          },
        ],
      },
      {
        path: "packages/provider-grok/src/server/textGeneration.ts",
        edits: [
          {
            find: "const GROK_TIMEOUT_MS = 180_000;",
            replace: "const GROK_TIMEOUT_MS = 60_000;",
          },
        ],
      },
      {
        path: "packages/provider-pi/src/server/textGeneration.ts",
        edits: [
          {
            find: "const PI_TIMEOUT_MS = 180_000;",
            replace: "const PI_TIMEOUT_MS = 60_000;",
          },
        ],
      },
    ],
    mentions: ["CLAUDE_TIMEOUT_MS", "6_000"],
    message: "Give up on stuck text generation after a minute",
    description:
      "six text generators drop their timeout from three minutes to one; the Claude copy is 6_000, so Claude commit messages, PR text and titles time out after six seconds",
    difficulty: "subtle",
  },
  {
    variant: 153,
    host: "devtools-frontend/2123472",
    category: "family",
    path: "front_end/elements/ElementsSidebarPane.js",
    edits: [
      {
        find: "new Common.Throttler.Throttler(100);",
        replace: "new Common.Throttler.Throttler(50);",
      },
    ],
    extraFiles: [
      {
        path: "front_end/elements/ElementsTreeElement.js",
        edits: [
          {
            find: "new Common.Throttler.Throttler(100);",
            replace: "new Common.Throttler.Throttler(50);",
          },
        ],
      },
      {
        path: "front_end/elements/ElementsTreeElementHighlighter.js",
        edits: [
          {
            find: "new Common.Throttler.Throttler(100);",
            replace: "new Common.Throttler.Throttler(500);",
          },
        ],
      },
      {
        path: "front_end/layers/LayersPanel.js",
        edits: [
          {
            find: "new Common.Throttler.Throttler(100);",
            replace: "new Common.Throttler.Throttler(50);",
          },
        ],
      },
      {
        path: "front_end/perf_ui/TimelineOverviewPane.js",
        edits: [
          {
            find: "new Common.Throttler.Throttler(100);",
            replace: "new Common.Throttler.Throttler(50);",
          },
        ],
      },
    ],
    mentions: ["ElementsTreeElementHighlighter", "Throttler(500)"],
    message: "Halve the update throttle in panel views",
    description:
      "five views cut their update throttle from 100 ms to 50; ElementsTreeElementHighlighter gets 500, so the tree follows a hovered page node five times slower than before",
    difficulty: "plain",
  },
  {
    variant: 154,
    host: "t3code/24813",
    category: "family",
    path: "packages/source-control-bitbucket/src/server/BitbucketApi.ts",
    edits: [
      {
        find: "const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;",
        replace: "const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;",
      },
    ],
    extraFiles: [
      {
        path: "packages/source-control-bitbucket/src/server/BitbucketPullRequestApi.ts",
        edits: [
          {
            find: "const DIFF_MAX_BYTES = 8 * 1024 * 1024;",
            replace: "const DIFF_MAX_BYTES = 32 * 1024 * 1024;",
          },
        ],
      },
      {
        path: "packages/source-control-github/src/server/GitHubPullRequestApi.ts",
        edits: [
          {
            find: "const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;",
            replace: "const DIFF_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;",
          },
        ],
      },
      {
        path: "packages/source-control-github/src/server/GitHubRest.ts",
        edits: [
          {
            find: "const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;",
            replace: "const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;",
          },
        ],
      },
      {
        path: "packages/source-control-github/src/server/gitHubGraphQlClient.ts",
        edits: [
          {
            find: "const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;",
            replace: "const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;",
          },
        ],
      },
      {
        path: "packages/source-control-gitlab/src/server/GitLabPullRequestCli.ts",
        edits: [
          {
            find: "const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;",
            replace: "const DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;",
          },
        ],
      },
    ],
    mentions: ["DIFF_MAX_OUTPUT_BYTES", "3 * 1024 * 1024"],
    message: "Raise source-control response limits to 32 MiB",
    description:
      "six source-control byte limits rise from 8 MiB to 32; the GitHub pull request diff limit becomes 3 MiB instead, so a GitHub diff over 3 MiB falls back to file pages and a changed-files page over 3 MiB fails, where both read up to 8 MiB before",
    difficulty: "subtle",
  },
];

/**
 * Why the plant table is not a valid append-only set; null when it is: numbers unique and from 101,
 * hosts named as source/number, and no file planted twice with the same category in one repository
 * (react-core and react-compiler are one).
 */
/** Case sources that are one repository: a file is the same file through either. */
export const REPOSITORY_OF: Readonly<Record<string, string>> = {
  "react-core": "react/react",
  "react-compiler": "react/react",
};
const repositoryOf = (host: string) => {
  const source = host.split("/")[0]!;
  return REPOSITORY_OF[source] ?? source;
};

export const plantTableProblem = (
  plants: ReadonlyArray<PlantSpec>,
): string | null => {
  const numbers = new Set<number>();
  const files = new Set<string>();
  const hosts = new Map<string, number>();
  for (const raw of plants) {
    const parsed = PlantSpec.safeParse(raw);
    if (!parsed.success)
      return `plant ${raw.variant}: ${parsed.error.issues[0]?.message ?? "invalid"}`;
    const plant = parsed.data;
    if (numbers.has(plant.variant))
      return `variant ${plant.variant} is defined twice`;
    numbers.add(plant.variant);
    for (const path of [
      plant.path,
      ...(plant.extraFiles ?? []).map((extra) => extra.path),
    ]) {
      const file = `${repositoryOf(plant.host)}:${path}:${plant.category}`;
      if (files.has(file))
        return `variant ${plant.variant} plants ${path} twice as ${plant.category}`;
      files.add(file);
    }
    // A host carries at most three plants across every category.
    const onHost = (hosts.get(plant.host) ?? 0) + 1;
    if (onHost > 3)
      return `variant ${plant.variant} is a fourth plant on ${plant.host}`;
    hosts.set(plant.host, onHost);
    if (
      plant.deletedAsPlanted !== undefined &&
      plant.category === "removed-behaviour"
    )
      return `variant ${plant.variant}: removed behaviour keys its deleted lines already`;
    if (plant.form !== undefined && plant.category !== "test-file")
      return `variant ${plant.variant}: only a test-file plant has a form`;
    if (plant.category === "test-file" && plant.form === undefined)
      return `variant ${plant.variant}: a test-file plant names its form`;
    if ((plant.extraFiles !== undefined) !== (plant.category === "family"))
      return `variant ${plant.variant}: only a family plant, and every family plant, edits extra files`;
    if (plant.variant >= 119 && plant.difficulty === undefined)
      return `variant ${plant.variant} has no difficulty`;
    if (!plant.mentions.some((m) => m.trim() !== ""))
      return `variant ${plant.variant} names nothing`;
  }
  return null;
};

// Records

const Range = z.strictObject({
  path: z.string(),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});

export const SourcePlantedRecord = z.strictObject({
  version: z.literal(1),
  set: z.literal("C"),
  caseId: z.string(),
  variant: z.int().min(101),
  host: z.strictObject({
    caseId: z.string(),
    source: z.string(),
    number: z.int(),
    base: z.string(),
    head: z.string(),
  }),
  /** The host range's size: today's units, files, and the class the gate's sizes ask for. */
  hostSize: z.strictObject({
    units: z.int().min(0),
    files: z.int().min(0),
    size: z.enum(["large", "medium", "small"]),
  }),
  problem: z.enum(CATEGORIES),
  /** Equal to `problem` for set C; the gate rolls set B up under `light-file`. */
  category: z.enum(CATEGORIES),
  kind: z.string(),
  language: z.string(),
  /** Whether the plant's file is one the host's own range changes. */
  hostTouchesFile: z.boolean(),
  commit: z.string(),
  message: z.string(),
  description: z.string(),
  /** The planted changed lines (new side, or old side for removed behaviour). */
  lines: z.array(Range).min(1),
  lineKeys: z.array(z.string()).min(1),
  /** Lines the defect depends on, which the plant does not change; new-side numbering. */
  related: z.array(Range),
  /**
   * Other places a correct finding may anchor that are not planted lines, derived from the
   * variant's diff: the old-side lines the plant replaced, and around a pure deletion the new-side
   * lines up to 3 above and 3 below the deletion point, inside the same hunk of the variant's range.
   */
  beside: z.array(Range),
  mentions: z.array(z.string()),
  /** The builder's judgement of how hard the plant is to see; plants from 119 on. */
  difficulty: z.enum(["plain", "subtle"]).optional(),
  /** A test-file plant's form (test-file only). */
  form: z.enum(TEST_FORMS).optional(),
  /** A family plant's copies, in path order, each copy's changed lines; `deviant` indexes the defect. */
  family: z
    .strictObject({ members: z.array(Range).min(5), deviant: z.int().min(1) })
    .optional(),
  expected: z.literal(
    "a finding Verify keeps, anchored on the planted lines (for cross-file, naming the related file or a mention)",
  ),
});
export type SourcePlantedRecord = z.infer<typeof SourcePlantedRecord>;

/** Large is 16 or more of today's units; small is a range of four files or fewer. */
export const sizeOf = (units: number, files: number) =>
  units >= 16 ? "large" : files <= 4 ? "small" : "medium";

const lineKeysOf = (ranges: ReadonlyArray<z.infer<typeof Range>>) =>
  ranges.flatMap((r) =>
    Array.from(
      { length: r.endLine - r.startLine + 1 },
      (_, i) => `${r.path}:${r.side}:${r.startLine + i}`,
    ),
  );

/** Contiguous line numbers to ranges. */
const toRanges = (
  path: string,
  side: "old" | "new",
  numbers: ReadonlyArray<number>,
) => {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: Array<z.infer<typeof Range>> = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && last.endLine === n - 1) last.endLine = n;
    else ranges.push({ path, side, startLine: n, endLine: n });
  }
  return ranges;
};

const expand = (ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.flatMap(([start, end]) =>
    Array.from({ length: end - start + 1 }, (_, i) => start + i),
  );

/**
 * Why a test-file plant's related code is not code the host's range changes; null when every line
 * a finding could anchor on is a changed head line of the host. The file being in the range is not
 * enough: an unchanged line beside the change is behaviour the range never shows.
 */
export const relatedOutsideRangeProblem = (
  related: ReadonlyArray<{
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly lines: ReadonlyArray<string>;
  }>,
  hostChanged: (path: string) => ReadonlySet<number>,
): string | null => {
  for (const range of related) {
    const changed = hostChanged(range.path);
    for (let n = range.startLine; n <= range.endLine; n++) {
      const text = range.lines[n - range.startLine] ?? "";
      if (!notAnchor(text, range.path) && !changed.has(n))
        return `related ${range.path}:${n} is not a line the host's range changes`;
    }
  }
  return null;
};

/** A line a finding would not anchor on: blank, only an import, or only a comment. */
export const notAnchor = (text: string, path: string) =>
  text.trim() === "" ||
  /^\s*(import\b|from\s+\S+\s+import\b)/.test(text) ||
  /^\s*(\w+\s+)?"[\w./-]+"\s*$/.test(text) ||
  isCommentLine(text, path);

/** The hunks of one path, `git diff -U<context> base head`, as old and new starts and counts. */
const hunksOf = (
  replay: string,
  base: string,
  head: string,
  path: string,
  context = 0,
) =>
  gitRun(replay, [
    "diff",
    "--no-color",
    "--no-renames",
    `-U${context}`,
    base,
    head,
    "--",
    path,
  ])
    .stdout.split("\n")
    .flatMap((line) => {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      return m === null
        ? []
        : [
            {
              oldStart: Number(m[1]),
              oldCount: m[2] === undefined ? 1 : Number(m[2]),
              newStart: Number(m[3]),
              newCount: m[4] === undefined ? 1 : Number(m[4]),
            },
          ];
    });

/**
 * The new-side lines around pure deletions: for each deletion point (the new line after which the
 * lines were deleted), up to 3 lines above and 3 below, kept inside the variant's hunk (with its
 * usual 3 lines of context) that holds the point, and never a blank line.
 */
export const besideAround = (
  points: ReadonlyArray<number>,
  hunks: ReadonlyArray<{ newStart: number; newCount: number }>,
  text: ReadonlyArray<string>,
) =>
  points.flatMap((point) => {
    const hunk = hunks.find(
      (h) => point >= h.newStart - 1 && point <= h.newStart + h.newCount - 1,
    );
    if (hunk === undefined) return [];
    const first = Math.max(point - 2, hunk.newStart, 1);
    const last = Math.min(
      point + 3,
      hunk.newStart + hunk.newCount - 1,
      text.length,
    );
    return Array.from(
      { length: Math.max(0, last - first + 1) },
      (_, i) => first + i,
    ).filter((n) => (text[n - 1] ?? "").trim() !== "");
  });

/**
 * A head line's number at the base, through the host's own hunks of that file; null when the host
 * added the line (it has no base counterpart, so deleting it would not show in the variant's range).
 */
export const baseLineOf = (
  hunks: ReadonlyArray<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }>,
  line: number,
): number | null => {
  let delta = 0;
  for (const h of hunks) {
    const newEnd = h.newStart + h.newCount - 1;
    if (h.newCount > 0 && line >= h.newStart && line <= newEnd) return null;
    const after = h.newCount === 0 ? line > h.newStart : line > newEnd;
    if (after) delta += h.oldCount - h.newCount;
  }
  return line + delta;
};

const show = (replay: string, revision: string, path: string) => {
  const out = Bun.spawnSync([
    "git",
    "-C",
    replay,
    "show",
    `${revision}:${path}`,
  ]);
  return out.exitCode === 0 ? out.stdout.toString() : null;
};

/** The plant's edits applied to the file's text; refuses a find that is missing or not unique. */
export const applyEdits = (
  text: string,
  edits: ReadonlyArray<{ find: string; replace: string }>,
) => {
  let out = text;
  for (const edit of edits) {
    const first = out.indexOf(edit.find);
    if (first === -1)
      throw new Error(`edit not found: ${edit.find.slice(0, 60)}`);
    if (out.indexOf(edit.find, first + 1) !== -1)
      throw new Error(`edit not unique: ${edit.find.slice(0, 60)}`);
    out =
      out.slice(0, first) + edit.replace + out.slice(first + edit.find.length);
  }
  return out;
};

/** Where `find` sits in `text`, as 1-based lines; refuses a missing or repeated text. */
export const locate = (text: string, find: string) => {
  const first = text.indexOf(find);
  if (first === -1)
    throw new Error(`related text not found: ${find.slice(0, 60)}`);
  if (text.indexOf(find, first + 1) !== -1)
    throw new Error(`related text not unique: ${find.slice(0, 60)}`);
  const startLine = text.slice(0, first).split("\n").length;
  return { startLine, endLine: startLine + find.split("\n").length - 1 };
};

const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Words a plant's commit must never carry: they would tell the review what was planted. */
const GIVEAWAY =
  /\b(plant(ed|s)?|neuve|answer key|out[- ]of[- ]scope|defect|missing test)\b/i;

/** Runs `read` with git's optional locks off, so even `git status` writes nothing. */
const withoutOptionalLocks = <T>(read: () => T): T => {
  const before = process.env["GIT_OPTIONAL_LOCKS"];
  process.env["GIT_OPTIONAL_LOCKS"] = "0";
  try {
    return read();
  } finally {
    if (before === undefined) delete process.env["GIT_OPTIONAL_LOCKS"];
    else process.env["GIT_OPTIONAL_LOCKS"] = before;
  }
};

/**
 * Commits the plant in `replay` (a clone that holds the host's commits) and derives its two records.
 * The records name `options.recorded` as the variant's clone, and its leakage checks read that
 * clone. Building a variant passes its new clone for both and `place` to move its branch and
 * worktree to the plant. Checking a built variant passes a throwaway clone as `replay`, so nothing
 * is written into the pinned clone: its checks run without optional locks. The same entry and host
 * always give the same commit and the same bytes.
 */
export const derivePlant = (
  host: Host,
  rawPlant: PlantSpec,
  replay: string,
  options: { readonly place: boolean; readonly recorded: string },
) => {
  const plant = PlantSpec.parse(rawPlant);
  const first = host.record.firstRevision!;
  const sources = [
    { path: plant.path, edits: plant.edits },
    ...(plant.extraFiles ?? []),
  ].map((file) => {
    const text = show(replay, first.head, file.path);
    if (text === null)
      throw new Error(`${file.path} does not exist at ${host.caseId}'s head`);
    return {
      path: file.path,
      original: text,
      content: applyEdits(text, file.edits),
    };
  });
  const author = gitRun(replay, [
    "log",
    "-1",
    "--format=%an%x00%ae%x00%ct",
    first.head,
  ])
    .stdout.trim()
    .split("\u0000");
  const headSeconds = Number(author[2]);
  const latest = Math.floor(new Date(first.at).getTime() / 1000) + 1_800;
  const date = new Date(
    Math.min(headSeconds + 600, latest) * 1000,
  ).toISOString();
  const commit = plantCommit(replay, {
    parent: first.head,
    edits: sources.map(({ path, content }) => ({ path, content })),
    message: plant.message,
    indexName: "plant",
    identity: { name: author[0]!, email: author[1]!, date },
  });
  if (options.place) {
    gitRun(replay, ["read-tree", "-m", "-u", first.head, commit]);
    gitRun(replay, [
      "update-ref",
      "--no-deref",
      "refs/heads/replay",
      commit,
      first.head,
    ]);
    run(["rm", "-rf", join(replay, ".git", "logs")]);
  }
  const files = plantFiles(replay, first.head, commit).map((file) => ({
    ...file,
    existedBefore: show(replay, first.head, file.path) !== null,
  }));
  const shape = sourceShapeProblem(plant.category, files, {
    hostFiles: host.rangeFiles,
    relatedPaths: plant.related.map((r) => r.path),
  });
  if (shape !== null) throw new Error(`variant ${plant.variant}: ${shape}`);
  // The file the answer key is about: the plant's one file, or a family's deviating copy.
  const familyOf = plant.category === "family" ? familyPattern(files) : null;
  if (typeof familyOf === "string")
    throw new Error(`variant ${plant.variant}: ${familyOf}`);
  const keyPath =
    familyOf === null ? plant.path : familyOf.paths[familyOf.deviant]!;
  const keySource = sources.find((source) => source.path === keyPath)!;
  const original = keySource.original;
  const content = keySource.content;
  const added = files.flatMap((f) => f.added);
  if (GIVEAWAY.test(plant.message) || added.some((line) => GIVEAWAY.test(line)))
    throw new Error(
      `variant ${plant.variant}: the commit names what was planted`,
    );

  // The planted lines: the plant's own changed lines, in the variant's numbering.
  const headText = content.split("\n");
  let lines: Array<z.infer<typeof Range>>;
  if (plant.category === "removed-behaviour") {
    const hunks = hunksOf(replay, first.base, first.head, keyPath);
    const atHead = expand(
      changedBaseLines(replay, first.head, commit).get(keyPath) ?? [],
    );
    const baseText = (show(replay, first.base, keyPath) ?? "").split("\n");
    const originalText = original.split("\n");
    const numbers = atHead
      .filter((n) => !notAnchor(originalText[n - 1] ?? "", keyPath))
      .map((n) => {
        const at = baseLineOf(hunks, n);
        if (at === null || baseText[at - 1] !== originalText[n - 1])
          throw new Error(
            `variant ${plant.variant}: deleted line ${n} is not a line of the host's base, so the range would not show it deleted`,
          );
        return at;
      });
    lines = toRanges(keyPath, "old", numbers);
  } else {
    const numbers = expand(
      changedHeadLines(replay, first.head, commit).get(keyPath) ?? [],
    ).filter((n) => !notAnchor(headText[n - 1] ?? "", keyPath));
    lines = toRanges(keyPath, "new", numbers);
    if (plant.deletedAsPlanted !== undefined) {
      const hunks = hunksOf(replay, first.base, first.head, keyPath);
      const atHead = expand(
        changedBaseLines(replay, first.head, commit).get(keyPath) ?? [],
      );
      const baseText = (show(replay, first.base, keyPath) ?? "").split("\n");
      const originalText = original.split("\n");
      const old = plant.deletedAsPlanted.map((text) => {
        const matches = atHead.filter((n) => originalText[n - 1] === text);
        if (matches.length !== 1)
          throw new Error(
            `variant ${plant.variant}: ${matches.length} deleted line(s) read ${JSON.stringify(text)}, not one`,
          );
        const at = baseLineOf(hunks, matches[0]!);
        if (at === null || baseText[at - 1] !== text)
          throw new Error(
            `variant ${plant.variant}: the deleted line ${JSON.stringify(text)} is not a line of the host's base`,
          );
        return at;
      });
      lines = [...lines, ...toRanges(keyPath, "old", old)];
    }
  }
  if (lines.length === 0)
    throw new Error(
      `variant ${plant.variant}: the plant changes no line a finding could anchor on`,
    );
  const lineRule = checkKind(
    "changed-lines",
    changedHeadLines(replay, first.base, commit),
    lines,
    changedBaseLines(replay, first.base, commit),
  );
  if (lineRule !== null)
    throw new Error(`variant ${plant.variant}: ${lineRule}`);

  const related = plant.related.map((r) => {
    const text = show(replay, commit, r.path);
    if (text === null)
      throw new Error(`variant ${plant.variant}: related ${r.path} is missing`);
    // From 119 on, related code is code: a comment-only range points no finding at what needs it.
    if (
      plant.variant >= 119 &&
      r.find
        .split("\n")
        .filter((line) => line.trim() !== "")
        .every((line) => isCommentLine(line, r.path))
    )
      throw new Error(
        `variant ${plant.variant}: related ${r.path} is only comments`,
      );
    return { path: r.path, side: "new" as const, ...locate(text, r.find) };
  });
  if (plant.category === "test-file") {
    // The behaviour a test-file plant leaves uncovered is behaviour the host's range changes.
    const hostChanged = changedHeadLines(replay, first.base, first.head);
    const outside = relatedOutsideRangeProblem(
      related.map((range) => ({
        ...range,
        lines: (show(replay, commit, range.path) ?? "")
          .split("\n")
          .slice(range.startLine - 1, range.endLine),
      })),
      (path) => new Set(expand(hostChanged.get(path) ?? [])),
    );
    if (outside !== null)
      throw new Error(`variant ${plant.variant}: ${outside}`);
  }
  if (plant.category === "cross-file") {
    const words = crossFileWordsProblem({
      mentions: plant.mentions,
      relatedTexts: plant.related.map((r) => r.find),
      relatedPaths: plant.related.map((r) => r.path),
      added,
      deleted: files.flatMap((f) => f.deleted),
      message: plant.message,
      plantPath: keyPath,
      // From 119 on the whole planted file is checked; 108 to 110 were checked by hand and are pinned.
      ...(plant.variant >= 119 ? { fileText: content } : {}),
    });
    if (words !== null) throw new Error(`variant ${plant.variant}: ${words}`);
  }

  // Beside the plant: the old-side lines it replaced, and the lines around a pure deletion.
  const plantedKeys = new Set(lineKeysOf(lines));
  const baseLines = (show(replay, first.base, keyPath) ?? "").split("\n");
  const hostOld = new Set(
    expand(changedBaseLines(replay, first.base, first.head).get(keyPath) ?? []),
  );
  const deletedTexts = new Set(files.flatMap((f) => f.deleted));
  const replaced = expand(
    changedBaseLines(replay, first.base, commit).get(keyPath) ?? [],
  ).filter(
    (n) =>
      !hostOld.has(n) &&
      deletedTexts.has(baseLines[n - 1] ?? "") &&
      !notAnchor(baseLines[n - 1] ?? "", keyPath) &&
      !plantedKeys.has(`${keyPath}:old:${n}`),
  );
  const deletionPoints = hunksOf(replay, first.head, commit, keyPath)
    .filter((h) => h.newCount === 0)
    .map((h) => h.newStart);
  const around = besideAround(
    deletionPoints,
    hunksOf(replay, first.base, commit, keyPath, 3),
    headText,
  ).filter((n) => !plantedKeys.has(`${keyPath}:new:${n}`));
  const beside = [
    ...toRanges(keyPath, "old", replaced),
    ...toRanges(keyPath, "new", around),
  ];

  const caseId = `planted:${plant.category}:${host.source}/${host.number}:${plant.variant}`;
  const record: Case = CaseRecord.parse({
    ...host.record,
    caseId,
    source: "planted",
    number: plant.variant,
    title: plant.message,
    selection: {
      score: 0,
      reasons: [
        `planted ordinary-source variant of ${host.caseId} (NEU-148 set C)`,
      ],
    },
    firstRevision: { ...first, head: commit },
    // The host's head is the plant's parent, so it is in the clone by design.
    later:
      host.record.later === null
        ? null
        : {
            finalHead:
              host.record.later.finalHead === first.head
                ? null
                : host.record.later.finalHead,
            merged:
              host.record.later.merged === first.head
                ? null
                : host.record.later.merged,
            revisions: host.record.later.revisions.filter(
              (sha) => sha !== first.head,
            ),
          },
    size: null,
    capture: { at: host.record.capture.at, files: [] },
    // Fixed to the plant's commit time, never the clock, so a rebuild writes the same bytes.
    clone: { path: options.recorded, preparedAt: date },
    checks: null,
    unavailable: null,
  });
  const checks = {
    ...(options.recorded === replay
      ? leakageChecks(record)
      : withoutOptionalLocks(() => leakageChecks(record))),
    checkedAt: date,
  };
  const units = host.units.length;
  const planted = SourcePlantedRecord.parse({
    version: 1,
    set: "C",
    caseId,
    variant: plant.variant,
    host: {
      caseId: host.caseId,
      source: host.source,
      number: host.number,
      base: first.base,
      head: first.head,
    },
    hostSize: {
      units,
      files: host.rangeFiles.size,
      size: sizeOf(units, host.rangeFiles.size),
    },
    problem: plant.category,
    category: plant.category,
    kind: KIND_OF[plant.category],
    language: languageOf(keyPath),
    hostTouchesFile: host.rangeFiles.has(keyPath),
    commit,
    message: plant.message,
    description: plant.description,
    lines,
    lineKeys: lineKeysOf(lines),
    related,
    beside,
    mentions: plant.mentions,
    ...(familyOf === null
      ? {}
      : {
          family: {
            members: familyOf.paths.map((path) => {
              const numbers = expand(
                changedHeadLines(replay, first.head, commit).get(path) ?? [],
              ).filter((n) => {
                const text = sources
                  .find((x) => x.path === path)!
                  .content.split("\n");
                return !notAnchor(text[n - 1] ?? "", path);
              });
              const ranges = toRanges(path, "new", numbers);
              if (ranges.length !== 1)
                throw new Error(
                  `variant ${plant.variant}: the family copy in ${path} is not one block of lines`,
                );
              return ranges[0]!;
            }),
            deviant: familyOf.deviant,
          },
        }),
    ...(plant.difficulty === undefined ? {} : { difficulty: plant.difficulty }),
    ...(plant.form === undefined ? {} : { form: plant.form }),
    expected:
      "a finding Verify keeps, anchored on the planted lines (for cross-file, naming the related file or a mention)",
  });
  return {
    commit,
    checks,
    caseText: `${JSON.stringify(CaseRecord.parse({ ...record, checks }), null, 2)}\n`,
    plantedText: `${JSON.stringify(planted, null, 2)}\n`,
    planted,
  };
};

/** Where set C's index is kept, beside set B's. */
export const SOURCE_SET = join(FULL_TEST_RESULTS, "lanes", "planted-source");
export const SOURCE_INDEX = join(SOURCE_SET, "set-c.json");

const hostCache = new Map<string, Host>();
const hostOf = (hostsRoot: string, key: string) => {
  const cached = hostCache.get(`${hostsRoot}|${key}`);
  if (cached !== undefined) return cached;
  const host = readHost(hostsRoot, key);
  hostCache.set(`${hostsRoot}|${key}`, host);
  return host;
};

/** One variant's state after a build or a verify. */
export interface VariantResult {
  readonly variant: number;
  readonly state: "built" | "unchanged";
  readonly planted: SourcePlantedRecord;
  readonly directory: string;
}

/**
 * Re-derives an existing variant and refuses any byte that moved: the commit, the replay branch,
 * case.json and planted.json. The plant is re-committed in a throwaway clone that borrows the host's
 * objects (`--shared`), never in the pinned clone, which is only read.
 */
const checkExisting = (
  hostsRoot: string,
  plant: PlantSpec,
  directory: string,
): VariantResult => {
  const replay = join(directory, "replay");
  if (!existsSync(join(replay, ".git")))
    throw new Error(`variant ${plant.variant}: ${replay} is missing`);
  const host = hostOf(hostsRoot, plant.host);
  const scratch = mkdtempSync(join(tmpdir(), "planted-source-check-"));
  let derived: ReturnType<typeof derivePlant>;
  try {
    const work = join(scratch, "replay");
    run([
      "git",
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--no-tags",
      "--single-branch",
      "--branch",
      "replay",
      host.replay,
      work,
    ]);
    derived = derivePlant(host, plant, work, {
      place: false,
      recorded: replay,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const head = gitRun(replay, ["rev-parse", "refs/heads/replay"]).stdout.trim();
  const problems = [
    head === derived.commit
      ? null
      : `its replay branch is ${head}, not ${derived.commit}`,
    readFileSync(join(directory, "case.json"), "utf8") === derived.caseText
      ? null
      : "case.json differs from its re-derivation",
    readFileSync(join(directory, "planted.json"), "utf8") ===
    derived.plantedText
      ? null
      : "planted.json differs from its re-derivation",
    derived.checks.passed ? null : "its leakage checks fail",
  ].filter((p): p is string => p !== null);
  if (problems.length > 0)
    throw new Error(`variant ${plant.variant}: ${problems.join("; ")}`);
  return {
    variant: plant.variant,
    state: "unchanged",
    planted: derived.planted,
    directory,
  };
};

/** Builds one new variant folder; removes it again if any rule fails. */
const buildNew = (
  hostsRoot: string,
  casesRoot: string,
  plant: PlantSpec,
): VariantResult => {
  const host = hostOf(hostsRoot, plant.host);
  const directory = join(casesRoot, "planted", String(plant.variant));
  if (existsSync(directory))
    throw new Error(`${directory} exists; a variant is never rebuilt in place`);
  mkdirSync(directory, { recursive: true });
  try {
    const replay = join(directory, "replay");
    run([
      "git",
      "clone",
      "--quiet",
      "--local",
      "--no-tags",
      "--single-branch",
      "--branch",
      "replay",
      host.replay,
      replay,
    ]);
    gitRun(replay, ["remote", "remove", "origin"]);
    const derived = derivePlant(host, plant, replay, {
      place: true,
      recorded: replay,
    });
    if (!derived.checks.passed)
      throw new Error(
        `variant ${plant.variant}: leakage checks failed ${JSON.stringify(derived.checks)}`,
      );
    writeFileSync(join(directory, "case.json"), derived.caseText);
    writeFileSync(join(directory, "planted.json"), derived.plantedText);
    return {
      variant: plant.variant,
      state: "built",
      planted: derived.planted,
      directory,
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

/** Old and new hashes of a replaced variant. */
export interface Replacement {
  readonly variant: number;
  readonly before: { case: string; planted: string; commit: string };
  readonly after: { case: string; planted: string; commit: string };
}

/**
 * The set C build, all or nothing. Every entry with no folder yet is built, and every existing one is
 * re-derived and must match its bytes. The committed index (when there is one) freezes what it pins:
 * a pinned number must keep its entry, and its result, rebuilt or checked, must have the pinned
 * commit and record hashes. `replace` names the one pinned variant this run may change. If anything
 * fails, the folders this build made are removed, a replaced variant's old folder is restored, and
 * the index is left as it was; otherwise the index is re-pinned as a whole.
 */
export const buildSourceSet = (options: {
  readonly hostsRoot: string;
  readonly casesRoot: string;
  readonly plants?: ReadonlyArray<PlantSpec>;
  readonly index?: string | null;
  readonly replace?: number;
}) => {
  const plants = options.plants ?? PLANTS;
  const table = plantTableProblem(plants);
  if (table !== null) throw new Error(table);
  const index = options.index === undefined ? SOURCE_INDEX : options.index;
  const pins = new Map(
    index !== null && existsSync(index)
      ? SourceIndex.parse(JSON.parse(readFileSync(index, "utf8"))).variants.map(
          (v) => [v.variant, v] as const,
        )
      : [],
  );
  if (options.replace !== undefined && !pins.has(options.replace))
    throw new Error(
      `variant ${options.replace} is not pinned: --replace changes a pinned variant only`,
    );
  const dropped = [...pins.keys()].filter(
    (n) => !plants.some((p) => p.variant === n),
  );
  if (dropped.length > 0)
    throw new Error(
      `pinned variant(s) ${dropped.join(", ")} have no entry: a pinned variant is never removed`,
    );
  const results: Array<VariantResult> = [];
  const made: Array<string> = [];
  let aside: { directory: string; backup: string } | null = null;
  let replacement: Replacement | null = null;
  try {
    for (const plant of [...plants].sort((a, b) => a.variant - b.variant)) {
      const directory = join(
        options.casesRoot,
        "planted",
        String(plant.variant),
      );
      const pin = pins.get(plant.variant);
      let result: VariantResult;
      if (options.replace === plant.variant) {
        const backup = join(
          options.casesRoot,
          "planted",
          `.${plant.variant}.replaced`,
        );
        if (existsSync(backup))
          throw new Error(`${backup} exists from an earlier run: remove it`);
        if (existsSync(directory)) {
          renameSync(directory, backup);
          aside = { directory, backup };
        }
        result = buildNew(options.hostsRoot, options.casesRoot, plant);
        made.push(directory);
      } else if (existsSync(directory))
        result = checkExisting(options.hostsRoot, plant, directory);
      else {
        result = buildNew(options.hostsRoot, options.casesRoot, plant);
        made.push(directory);
      }
      const hashes = {
        case: sha(join(directory, "case.json")),
        planted: sha(join(directory, "planted.json")),
        commit: result.planted.commit,
      };
      if (pin !== undefined) {
        const before = {
          case: pin.case.sha256,
          planted: pin.planted.sha256,
          commit: pin.replay.commit,
        };
        if (options.replace === plant.variant)
          replacement = { variant: plant.variant, before, after: hashes };
        else if (
          hashes.case !== before.case ||
          hashes.planted !== before.planted ||
          hashes.commit !== before.commit
        )
          throw new Error(
            `variant ${plant.variant} is pinned and its result differs from the pin (${[
              hashes.commit === before.commit ? null : "commit",
              hashes.case === before.case ? null : "case.json",
              hashes.planted === before.planted ? null : "planted.json",
            ]
              .filter(Boolean)
              .join(", ")}): pass --replace ${plant.variant} to change it`,
          );
      }
      results.push(result);
    }
  } catch (error) {
    for (const directory of made)
      rmSync(directory, { recursive: true, force: true });
    if (aside !== null) renameSync(aside.backup, aside.directory);
    throw error;
  }
  if (aside !== null) rmSync(aside.backup, { recursive: true, force: true });
  const pinned = indexOf(results);
  if (index !== null) {
    mkdirSync(join(index, ".."), { recursive: true });
    writeFileSync(index, `${JSON.stringify(pinned, null, 2)}\n`);
  }
  return { results, index: pinned, replacement };
};

const countBy = <T>(items: ReadonlyArray<T>, key: (item: T) => string) =>
  Object.fromEntries(
    [...new Set(items.map(key))]
      .sort()
      .map((k) => [k, items.filter((i) => key(i) === k).length]),
  );

/** The index: every variant pinned by its records' hashes and its replay head, with the counts. */
const indexOf = (results: ReadonlyArray<VariantResult>) => {
  const planted = results.map((r) => r.planted);
  return {
    version: 1,
    set: "C",
    counts: {
      variants: planted.length,
      byCategory: countBy(planted, (p) => p.category),
      byLanguage: countBy(planted, (p) => p.language),
      bySize: countBy(planted, (p) => p.hostSize.size),
      byCategoryAndLanguage: countBy(
        planted,
        (p) => `${p.category} ${p.language}`,
      ),
      byCategoryAndSize: countBy(
        planted,
        (p) => `${p.category} ${p.hostSize.size}`,
      ),
    },
    variants: results.map((r) => ({
      variant: r.variant,
      caseId: r.planted.caseId,
      problem: r.planted.problem,
      category: r.planted.category,
      language: r.planted.language,
      host: r.planted.host.caseId,
      hostSize: r.planted.hostSize,
      hostTouchesFile: r.planted.hostTouchesFile,
      case: {
        path: join(r.directory, "case.json"),
        sha256: sha(join(r.directory, "case.json")),
      },
      planted: {
        path: join(r.directory, "planted.json"),
        sha256: sha(join(r.directory, "planted.json")),
      },
      replay: { ref: "refs/heads/replay", commit: r.planted.commit },
    })),
  };
};

export const SourceIndex = z.looseObject({
  version: z.literal(1),
  set: z.literal("C"),
  variants: z.array(
    z.looseObject({
      variant: z.int(),
      case: z.strictObject({ path: z.string(), sha256: z.string() }),
      planted: z.strictObject({ path: z.string(), sha256: z.string() }),
      replay: z.strictObject({ ref: z.string(), commit: z.string() }),
    }),
  ),
});

/**
 * Verifies the pinned set without writing a variant: every record's hash against the index, every
 * replay head against its pin, and every variant re-derived from its entry and host, byte for byte.
 */
export const verifySourceSet = (options: {
  readonly hostsRoot: string;
  readonly index?: string;
  readonly plants?: ReadonlyArray<PlantSpec>;
}) => {
  const path = options.index ?? SOURCE_INDEX;
  if (!existsSync(path))
    throw new Error(`${path} is missing: build set C first`);
  const index = SourceIndex.parse(JSON.parse(readFileSync(path, "utf8")));
  const plants = new Map((options.plants ?? PLANTS).map((p) => [p.variant, p]));
  const problems: Array<string> = [];
  for (const v of index.variants) {
    const plant = plants.get(v.variant);
    if (plant === undefined) {
      problems.push(`variant ${v.variant} has no entry in PLANTS`);
      continue;
    }
    try {
      for (const [name, pin] of [
        ["case.json", v.case],
        ["planted.json", v.planted],
      ] as const) {
        if (!existsSync(pin.path)) {
          problems.push(`variant ${v.variant}: ${name} is missing`);
          continue;
        }
        if (sha(pin.path) !== pin.sha256)
          problems.push(
            `variant ${v.variant}: ${name} changed since it was pinned`,
          );
      }
      const result = checkExisting(
        options.hostsRoot,
        plant,
        join(v.case.path, ".."),
      );
      if (result.planted.commit !== v.replay.commit)
        problems.push(
          `variant ${v.variant}: commit ${result.planted.commit} is not the pinned ${v.replay.commit}`,
        );
    } catch (error) {
      problems.push(String(error instanceof Error ? error.message : error));
    }
  }
  const unpinned = [...plants.keys()].filter(
    (n) => !index.variants.some((v) => v.variant === n),
  );
  return { variants: index.variants.length, unpinned, problems };
};
