import { posix } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { gitWithInput } from "./git.ts";
import { readBlobs, type TreeEntry } from "./git-objects.ts";
import { LINGUIST_STANDARD } from "./linguist/index.ts";
import {
  allUnspecified,
  ambiguousAttributes,
  AttributesUnreadable,
  CONTROL_FILES_RECIPE,
  linguistBlobReadable,
  linguistListMarks,
  linguistMarkOf,
  readCommitAttributes,
  readLinguistMarks,
  READ_BOUND_BYTES,
} from "./linguist-lists.ts";

/**
 * What a repository declares about its own files (10.23, PC4, PC7): generated, test and
 * documentation files are suggested only by the repository's own declarations, read by declared
 * readers, never by name or extension lists (constitution), with one exception: GitHub Linguist's
 * generated and vendored lists (decision 14.18, the `linguist` reader below). Each reader states
 * what it reads. A declaration is a suggestion that Understand weighs; everything no reader
 * declares is `undeclared` and counts like any other file. Readers in M3:
 *
 * - `gitattributes`: git's own attributes at the revision (`linguist-generated`, `-diff`,
 *   `linguist-documentation`), read with `git check-attr --source`, the user's global attributes
 *   file ignored so only the repository's declarations count;
 * - `generated-marker`: a generated-file marker in a file's first 1,024 bytes;
 * - `linguist`, only where the caller asks (`options.linguist`; the range manifest does): for each
 *   path asked, a suggestion of kind `generated` with `standard` (`linguist-generated` or
 *   `linguist-vendored`) when GitHub Linguist's generated or vendored list, pinned to v9.7.0
 *   (`linguist/`), marks the file with the repository's attributes applied. The decision is the
 *   `generated` rule's own (`linguist-lists.ts`, which `section-rules.ts` imports too): the
 *   attributes are read in an isolated Git directory over the revision's objects (only its
 *   `.gitattributes` files count, never a local, system or user file); `linguist-generated` or
 *   `linguist-vendored` set, or any string but `false`, marks the file with that list; unset or
 *   `false` takes that list's mark away; a path whose attribute read is unsure (a literal
 *   `=unset` or `=unspecified`, or an attributes file over it not read) gets none, and an
 *   attribute read that cannot see the revision's objects marks nothing (a gap says so). The
 *   blob is read as the rule reads it: a regular blob within 1,048,576 bytes is read whole (above
 *   131,072 bytes a content rule marks only when both of Linguist's readers' views agree); a
 *   larger blob, a symbolic link or a submodule is marked by path rules only, and its content
 *   rules give no mark, so the file is read. `by` names the version, the list and the rule, the
 *   pattern or the attribute that fired. A well-known control file (`CONTROL_FILES`: a GitHub
 *   Actions workflow, a root `Jenkinsfile`, `.teamcity/`, `.gitmodules`, any `.gitignore` or
 *   `.gitattributes`) that only the lists mark is kept: no suggestion, so it is read. The
 *   repository's attribute set still marks it. A mark is never an approval, and it is disclosed;
 * - `package-scripts-bun-test`: where a package manifest's scripts run Bun's test runner, with
 *   Bun's own documented discovery rule for which files there are tests. The rule is the tool's,
 *   applied only where the repository declares that the tool runs. Each script is read as a shell
 *   reads it (`scriptCommands`: quotes, operators, redirections, expansions) into commands of
 *   words. A command runs the test runner as `bun test`, or as `bun <file>` when the `bunfig.toml`
 *   beside the manifest names that same file in its `[test].preload` (the repository's own test
 *   wrapper; the file is never read or run). After either form, Bun reads a word as a path only
 *   when it starts with `./`, `../` or `/`; any other word is a filter on test files' paths, which
 *   narrows nothing. The path words that are a file or directory in the revision's tree are the
 *   roots (a file root is a test whatever its name); with none and nothing unconfirmed, the root
 *   is the package's directory (`bunTestRoots`). Under a directory root, as Bun's discovery does,
 *   a file below a hidden directory or `node_modules` is skipped. One rule above the others: what
 *   the reader does not fully understand declares nothing (a script it cannot read, a compound
 *   command or a builtin that runs other text, a word the shell would change, a path the tree
 *   cannot confirm, a change of directory, Bun's ignore patterns or a `[test].root` it does not
 *   apply, a `bunfig.toml` whose `[test]` table it cannot see or that is a symbolic link). Past
 *   200,000 script words per call the remaining manifests are not read, and a gap says so. Limits
 *   that remain, all wider than Bun runs:
 *   - a path word written as a flag's value is a root when it is a path in the tree;
 *   - a filter declares the whole package's directory, as if it matched every test file there;
 *   - a root script with no path argument declares every test-named file in the repository, as a
 *     bare `bun test` there does;
 *   - the words `bun test` are matched anywhere in a command, so `echo bun test` counts; the
 *     wrapper form counts only as the command itself, after any leading `NAME=value` words.
 *
 * Gaps, disclosed with every result: no reader declares lockfiles, and other test runners, other
 * test configuration and documentation tools are not read.
 *
 * What the reader could not settle is `undecided` (path to `by`), never a declaration: a name only
 * withholds, it never makes a file a test, and `testStatusOf` is the one question it answers. A
 * file is `not-test` only when nothing could make it a test: it matches no test-file convention
 * (Bun's rule, `TEST_CONVENTIONS` or `TEST_FOLDERS`), no followed script names it as a file root,
 * holds it under a test root it names or gives it to another runner, and no runner configuration the reader does not read (`RUNNER_CONFIGS`, a
 * runner key in a `package.json`, a manifest it did not read) covers it.
 *
 * - Every file named like a test that is not declared one is undecided. One named like a Bun test
 *   takes the `by` of the nearest place the `bun test` reader gave up (its own package's first in
 *   manifest and script order, else the first place whose run may go anywhere, `StopScope`), else
 *   Bun's rule (`BUN_NAMED_BY`); any other takes the convention it matches.
 * - Every file in a test folder (`TEST_FOLDERS`: Jest's `__tests__/` and `__mocks__/`) is undecided.
 * - Every other file a followed script gives another runner (`RUNNER_COMMANDS`), or that lies
 *   under a directory it gives one, is undecided, by that script.
 * - Every other file under a directory a followed script names as Bun's test root (`./tests`: a
 *   helper or a fixture there) is undecided, by the nearest such root and its script. The
 *   package's directory, a root by default (a bare `bun test`, or only filter words), is not
 *   named.
 * - Every other path under a directory a runner configuration covers is undecided, by that
 *   configuration.
 * - Every other path in a package where a script's words may name any file (an opaque positional
 *   word given to a test runner, `--config` or a path the tree does not confirm given to another
 *   runner) is undecided. The package is the manifest's directory less any nested directory with
 *   its own `package.json`.
 * - A path the declarations were not read for is undecided (`NOT_ASKED_BY`).
 *
 * - Every path a script names is undecided, whether or not the reader follows the script, the
 *   command or the runner (`scriptPathsOf`): each word of a command not on `NEVER_RUNS_TESTS`, a
 *   file, every path under a directory, every path a glob matches; a `cd` to an opaque word, or an
 *   opaque word the reader does not read under a runner's own rules, reaches the whole package.
 *   A pinned runner's flag that changes what it collects (`RunnerCommand.collects`) reaches the
 *   whole package too.
 *
 * Known limits, accepted (one line each):
 * - a helper outside those conventions, in a package whose test root is its directory by default,
 *   reads as source (not-test);
 * - a word a runner resolves itself without naming a tree path (a module name without its
 *   extension, a name it looks up on its own path) names nothing;
 * - a pinned runner invoked by its path (`./node_modules/.bin/mocha`) is read as an unknown
 *   command: its paths count, its flags do not;
 * - a runner outside the pinned lists (`deno test`, `jasmine`, `uvu`, Cargo) has only its paths
 *   counted;
 * - an opaque word in a root manifest's `bun test` reaches the root package, not its workspaces
 *   (the coordinator's ruling);
 * - a glob given to a runner outside the pinned lists names the files it matches, not the
 *   directories (`custom-runner checks/*`);
 * - a command word that is itself a path (`./checks/smoke.sh`) is not read as a named path;
 * - `bun run` given a glob as its first word (`bun run ./scripts/*.ts`) takes it as the script's
 *   name; `bun run ./file.ts` runs a program, not tests;
 * - `cd -P` and `cd --` lose the directory (the word after them is not read as the target);
 * - a manifest the reader cannot read reaches its own package: a path outside it that one of its
 *   unread scripts names (`bun test ../../src/check.ts`) is left to the other rules.
 *
 * The closing rule: where the reader does not follow a script (after a change of directory,
 * inside `if`/`then`/`fi`, a subshell, or any form it gives up on), a pinned runner, or an
 * interpreter (`node`, `python`, `python3`, `bun`, `deno`, `playwright`) given any word the
 * reader cannot resolve to a path, makes the script's package undecided; flags there are not
 * read. In a followed command, an interpreter given an opaque word (`node $SCRIPT`) does too,
 * unless it is a pinned runner's full form (`node --test`), which has its own rules. Bun's
 * `--cwd` is followed as a change of directory; `bun run --filter` or `--workspaces` passing
 * words on makes every path under the package undecided.
 */

export const DeclaredKind = z.enum(["generated", "test", "doc"]);
export type DeclaredKind = z.infer<typeof DeclaredKind>;

export const LinguistStandard = z.enum([
  "linguist-generated",
  "linguist-vendored",
]);

export const Suggestion = z.strictObject({
  kind: DeclaredKind,
  /** The reader and what it saw, e.g. `gitattributes: linguist-generated=true`. */
  by: z.string().min(1),
  /**
   * The Linguist list that marks the file, only on the `linguist` reader's suggestions: the mark is
   * the standard's, with the repository's attributes applied, not a declaration the repository
   * wrote. Absent, the suggestion is the repository's own, as before.
   */
  standard: LinguistStandard.optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** Every reader; `linguist` runs only where the caller asks, and is listed only then. */
export const DECLARATION_READERS = [
  "gitattributes",
  "generated-marker",
  "package-scripts-bun-test",
  "linguist",
] as const;

/**
 * The `linguist` reader's standing gap, added to a call's gaps where the reader runs. Not in
 * `DECLARATION_GAPS`, which are the gaps of every call.
 */
export const LINGUIST_GAP = `linguist: a blob over ${READ_BOUND_BYTES.toLocaleString("en-US")} bytes, a symbolic link or a submodule is marked by Linguist's path rules only; its content rules give no mark, so the file is read`;

export const DECLARATION_GAPS = [
  "no reader declares lockfiles: a lockfile counts as undeclared unless .gitattributes marks it",
  "package scripts are read only for `bun test` and for `bun <file>` where the package's own `bunfig.toml` names that file in `[test].preload`; other test runners, other test configuration and documentation tools' configuration are not read",
];

/**
 * The `linguist` reader's recipe: the pinned standard (version, commit, carried files' recipe and
 * how its two readers' views are weighed) and this reader's rules. Part of the key of what runs
 * the reader (the range manifest), not of `DECLARATIONS_RECIPE`, since every other caller leaves
 * it off.
 */
export const LINGUIST_READER_RECIPE = {
  reader: "neuve-declarations-linguist-v1",
  standard: {
    name: LINGUIST_STANDARD.name,
    version: LINGUIST_STANDARD.version,
    commit: LINGUIST_STANDARD.commit,
    recipe: LINGUIST_STANDARD.recipe,
    views: LINGUIST_STANDARD.reader,
  },
  readBytes: READ_BOUND_BYTES,
  controlFiles: CONTROL_FILES_RECIPE,
} as const;

/** Part of every key that depends on declarations. */
export const DECLARATIONS_RECIPE = "neuve-declarations-v4";

const GENERATED_MARKER =
  /@generated|do not edit|auto-?generated|automatically generated/i;
const MARKER_BYTES = 1_024;
// At most 16 MiB of prefixes per call, below the snapshot's 64 MiB allowance.
const MARKER_GROUP_PATHS = 16_384;

/** `git check-attr` over the paths at a revision, in groups, with only the repository's files. */
const attributes = (
  repository: string,
  revision: string,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const found = new Map<string, Array<Suggestion>>();
    const add = (path: string, suggestion: Suggestion) =>
      found.set(path, [...(found.get(path) ?? []), suggestion]);
    // Bound both input bytes and the number of response triples. NUL framing preserves
    // newlines, tabs and leading dashes without quoting or an argv-size limit.
    for (let at = 0; at < paths.length;) {
      const group: string[] = [];
      let bytes = 0;
      while (at < paths.length && group.length < 16_384) {
        const path = paths[at];
        if (path === undefined) break;
        const size = Buffer.byteLength(path) + 1;
        if (group.length > 0 && bytes + size > 1024 * 1024) break;
        if (path.includes("\0")) throw new Error("Invalid attribute path");
        group.push(path);
        bytes += size;
        at++;
      }
      const out = yield* gitWithInput(
        repository,
        [
          "-c",
          "core.attributesFile=/dev/null",
          "check-attr",
          "-z",
          "--stdin",
          `--source=${revision}`,
          "linguist-generated",
          "linguist-documentation",
          "diff",
        ],
        `${group.join("\0")}\0`,
      );
      const fields = out.split("\0");
      for (let index = 0; index + 2 < fields.length; index += 3) {
        const path = fields[index] ?? "";
        const attribute = fields[index + 1] ?? "";
        const value = fields[index + 2] ?? "";
        if (
          attribute === "linguist-generated" &&
          (value === "set" || value === "true")
        )
          add(path, {
            kind: "generated",
            by: `gitattributes: linguist-generated=${value}`,
          });
        if (attribute === "diff" && value === "unset")
          add(path, { kind: "generated", by: "gitattributes: -diff" });
        if (
          attribute === "linguist-documentation" &&
          (value === "set" || value === "true")
        )
          add(path, {
            kind: "doc",
            by: `gitattributes: linguist-documentation=${value}`,
          });
      }
    }
    return found;
  });

/**
 * The `linguist` reader (rules in the module comment): per path asked, the lists that mark it at
 * `revision`, with its attributes read at `attributesAt` (the revision unless the caller names
 * the one the `generated` rule reads). `tree` is the revision's listing, for each path's blob.
 */
const linguist = (
  repository: string,
  attributesAt: string,
  tree: ReadonlyArray<TreeEntry>,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const found = new Map<string, Array<Suggestion>>();
    const gaps: Array<string> = [];
    const asked = [...new Set(paths)].sort(byCodeUnits);
    if (asked.length === 0) return { found, gaps };
    const attempt = yield* Effect.result(
      readCommitAttributes(repository, attributesAt, asked),
    );
    if (attempt._tag === "Failure") {
      // As the rule cannot judge such a file, nothing is marked: every file is read.
      if (attempt.failure instanceof AttributesUnreadable) {
        gaps.push(
          `linguist: ${attempt.failure.message}; no file was marked by Linguist's lists`,
        );
        return { found, gaps };
      }
      return yield* Effect.fail(attempt.failure);
    }
    const read = attempt.success;
    const ambiguous = ambiguousAttributes(read.files, read.values, asked);
    const entryAt = new Map(
      tree
        .filter((entry) => entry.type === "blob" || entry.type === "commit")
        .map((entry) => [entry.path, entry]),
    );
    const blobs = asked.flatMap((path) => {
      const entry = entryAt.get(path);
      return entry === undefined
        ? []
        : [{ path, oid: entry.oid, mode: entry.mode, size: entry.size }];
    });
    const marks = yield* readLinguistMarks(repository, blobs);
    // A blob within the bound that the reader did not return (missing, or held back by a read
    // snapshot's memory bound) is marked by its path alone, and disclosed.
    const missing = blobs.filter(
      (blob) =>
        linguistBlobReadable(blob.path, blob.mode) &&
        blob.size !== null &&
        blob.size <= READ_BOUND_BYTES &&
        marks.get(blob.path)?.read !== true,
    ).length;
    if (missing > 0)
      gaps.push(
        `linguist: ${missing} blob(s) could not be read; Linguist's content rules were not checked for them, so only its path rules could mark them`,
      );
    for (const path of asked)
      // A well-known control file the lists marked is kept (`kept`): it gets no suggestion.
      for (const { standard, by } of linguistListMarks(
        {
          attributes: read.values.get(path) ?? allUnspecified(),
          trust: { ambiguous: ambiguous.get(path) ?? [] },
          mark: marks.get(path)?.mark ?? linguistMarkOf(path),
        },
        path,
      ).marks)
        found.set(path, [
          ...(found.get(path) ?? []),
          { kind: "generated", by, standard },
        ]);
    return { found, gaps };
  });

const PackageManifest = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
});

/**
 * Bun's documented test discovery rule (`bun test`): a file whose name ends in `.test`, `_test`,
 * `.spec` or `_spec` before a JavaScript or TypeScript suffix. Part of the `bun test` reader only:
 * it says which files Bun runs under a root the repository's scripts hand it.
 */
export const BUN_TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** The largest package manifest read. */
const MANIFEST_BYTES = 1_048_576;
/**
 * The largest `bunfig.toml` read. Bun's TOML parser is synchronous and quadratic in the number of
 * keys (a 1 MiB file takes seconds), so a larger one names nothing and is a disclosed gap.
 */
const BUNFIG_BYTES = 65_536;
const BUNFIG_OVERSIZED = `is over ${BUNFIG_BYTES / 1024} KiB and was not read`;
/** The script words one call reads, counted per directory, before it stops reading manifests. */
const WORD_BUDGET = 200_000;
/** A `[test].preload` list longer than this is not a test setup the reader follows. */
const PRELOAD_LIMIT = 256;
/** A symbolic link's blob is its target text, never configuration. */
const SYMLINK_MODE = "120000";

/**
 * Whether Bun's discovery skips a file at `rest` below the root it searches: a directory between
 * the root and the file's name starts with `.` or is `node_modules`.
 */
const skippedBelow = (rest: string) => {
  const directories = rest.split("/").slice(0, -1);
  return directories.some(
    (part) => part.startsWith(".") || part === "node_modules",
  );
};

/** A path or script word longer than this is never a path the reader confirms. */
const PATH_BYTES = 4_096;

/** What a repository path is in the tree; a path under a submodule link counts as the link. */
export type PathKind = "file" | "directory" | "link";

/**
 * Lookups in a revision's tree that keep no memory per directory. A file is a blob of the tree,
 * looked up in the caller's map of blobs by path. A directory is a path that some entry's path
 * starts with, followed by `/`; a link is a submodule link, or a path under one. Both use one array
 * of the entries' paths (references to the listing's own strings; entries over 4,096 bytes left
 * out, since no script word can name them) and one of the links' paths with `/` appended, each
 * sorted once per call, and only when a script first asks.
 */
export interface TreePaths {
  readonly kindOf: (path: string) => PathKind | undefined;
}

/** Plain code-unit order, the one comparison for both the sort and the search. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The index of the first item not less than `key` in a sorted array. */
const lowerBound = (sorted: ReadonlyArray<string>, key: string) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? "") < key) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Lookups in the tree; `blobs` is the caller's map of the tree's blobs by path, when it has one. */
export const treePathsOf = (
  tree: ReadonlyArray<TreeEntry>,
  blobs: ReadonlyMap<string, TreeEntry> = new Map(
    tree.filter((entry) => entry.type === "blob").map((e) => [e.path, e]),
  ),
): TreePaths => {
  let sorted:
    | { readonly paths: Array<string>; readonly links: Array<string> }
    | undefined;
  const lists = () => {
    if (sorted !== undefined) return sorted;
    const paths: Array<string> = [];
    const links: Array<string> = [];
    for (const entry of tree) {
      if (entry.type !== "blob" && entry.type !== "commit") continue;
      if (
        entry.path.length > PATH_BYTES ||
        Buffer.byteLength(entry.path) > PATH_BYTES
      )
        continue;
      paths.push(entry.path);
      if (entry.type === "commit") links.push(`${entry.path}/`);
    }
    sorted = { paths: paths.sort(byCodeUnits), links: links.sort(byCodeUnits) };
    return sorted;
  };
  const kindOf = (path: string): PathKind | undefined => {
    if (path === "") return "directory";
    if (blobs.get(path)?.type === "blob") return "file";
    const { paths, links } = lists();
    const below = `${path}/`;
    // No entry lies under a link, so the greatest link not greater than the path is the only one
    // that can hold it. A malformed tree that nests links can make this miss; the word is then
    // unconfirmed, the safe direction.
    const at = lowerBound(links, below);
    const link = links[at] === below ? below : links[at - 1];
    if (link !== undefined && below.startsWith(link)) return "link";
    const first = paths[lowerBound(paths, below)];
    return first !== undefined && first.startsWith(below)
      ? "directory"
      : undefined;
  };
  return { kindOf };
};

/** The directory of a repository path, `""` for the root. */
const directoryOf = (path: string) => {
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
};

/** The value held for the nearest directory above a path, its own first, up to the root. */
const nearestAt = <T>(
  at: ReadonlyMap<string, T>,
  path: string,
): T | undefined => {
  for (
    let directory = directoryOf(path);
    ;
    directory = directoryOf(directory)
  ) {
    const held = at.get(directory);
    if (held !== undefined) return held;
    if (directory === "") return undefined;
  }
};

/**
 * A relative path written in a repository file, resolved against a repository directory; undefined
 * when it is empty, longer than 4,096 bytes, absolute, holds a NUL or climbs out of the repository.
 */
const resolveIn = (directory: string, word: string): string | undefined => {
  if (
    word === "" ||
    Buffer.byteLength(word) > PATH_BYTES ||
    word.includes("\0") ||
    posix.isAbsolute(word)
  )
    return undefined;
  const path = posix
    .normalize(posix.join(directory, word))
    .replace(/(?<=.)\/+$/, "");
  if (path === ".." || path.startsWith("../")) return undefined;
  return path === "." ? "" : path;
};

const BunfigPreload = z.union([
  z.string(),
  z.array(z.string()).max(PRELOAD_LIMIT),
]);

/** What the reader takes from a `bunfig.toml`'s `[test]` table. */
interface BunfigTestTable {
  /** The `preload` strings as written; nothing for any other shape. */
  readonly preloads: ReadonlyArray<string>;
  /**
   * The table may narrow the files Bun runs: it sets `root` or `pathIgnorePatterns`, which the
   * reader does not apply, or the reader cannot see it (the file is over 64 KiB or not valid TOML,
   * or its `test` value is not a table). The manifest beside it then declares no tests.
   */
  readonly narrows: boolean;
  /** The file is not valid TOML. */
  readonly invalid: boolean;
  /**
   * When the table narrows: what the reader saw, as the end of a sentence about the file (`sets
   * [test].root`, `is not valid TOML`), for the files it leaves undecided.
   */
  readonly why?: string;
  /** The reader could not see the table at all (it does not know the preloads either). */
  readonly unseen?: boolean;
}

/**
 * The repository paths a `bunfig.toml`'s `[test].preload` names, resolved against its directory.
 * Parsed as TOML, never run. A file over 64 KiB or that is not TOML, a `test` value that is not a
 * table, or a `preload` that is not a string or a list of at most 256 strings, names nothing; an
 * absolute path or one that climbs out is ignored.
 */
export const bunfigTestPreloads = (
  bunfigPath: string,
  bunfigText: string,
): ReadonlyArray<string> =>
  resolvePreloads(bunfigPath, bunfigTestTable(bunfigText).preloads);

/** The `[test]` table as the reader takes it. A file with no `test` key narrows nothing. */
const bunfigTestTable = (bunfigText: string): BunfigTestTable => {
  const unseen = (why: string) => ({
    preloads: [],
    narrows: true,
    invalid: false,
    why,
    unseen: true,
  });
  if (Buffer.byteLength(bunfigText) > BUNFIG_BYTES)
    return unseen(BUNFIG_OVERSIZED);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(bunfigText);
  } catch {
    return { ...unseen("is not valid TOML"), invalid: true };
  }
  if (typeof parsed !== "object" || parsed === null)
    return unseen("is not a TOML table");
  if (!Object.hasOwn(parsed, "test"))
    return { preloads: [], narrows: false, invalid: false };
  const test: unknown = (parsed as Record<string, unknown>)["test"];
  if (typeof test !== "object" || test === null || Array.isArray(test))
    return unseen("has a test value that is not a table");
  const table = test as Record<string, unknown>;
  const narrowing = Object.hasOwn(table, "root")
    ? "sets [test].root"
    : Object.hasOwn(table, "pathIgnorePatterns")
      ? "sets [test].pathIgnorePatterns"
      : undefined;
  const preload = BunfigPreload.safeParse(table["preload"]);
  return {
    preloads: !preload.success
      ? []
      : typeof preload.data === "string"
        ? [preload.data]
        : preload.data,
    narrows: narrowing !== undefined,
    invalid: false,
    ...(narrowing === undefined ? {} : { why: narrowing }),
  };
};

const resolvePreloads = (
  bunfigPath: string,
  written: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const directory = directoryOf(bunfigPath);
  return written.flatMap((path) => {
    const resolved = resolveIn(directory, path);
    return resolved === undefined || resolved === "" ? [] : [resolved];
  });
};

/** A word of a script, its quoting removed, as the program would receive it. */
export interface ScriptWord {
  readonly text: string;
  /** The shell would change it before the program sees it (expansion, glob, `~`). */
  readonly opaque: boolean;
  /** A leading `NAME=value` word, the name and `=` unquoted. */
  readonly assignment: boolean;
}

/** A shell name followed by `=`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A package script read as a shell reads it, in one pass linear in its length: the commands it
 * holds, each a list of words with quoting removed and redirections taken out. Undefined when the
 * reader does not fully understand the script, which then declares nothing.
 *
 * - Outside quotes a space or tab ends a word; a line break, `;`, `&&`, `||`, `|`, `|&` and `&` end
 *   a command; a backslash makes the next character literal, and before a line break joins the
 *   lines.
 * - Single quotes keep everything to the next `'`. Double quotes keep everything to the next `"`;
 *   a backslash there escapes only `$`, a backtick, `"`, `\` and a line break, as in a shell.
 * - A word with an unquoted `$`, `*`, `?`, `[`, `{`, a leading `~`, or a `$` inside double quotes,
 *   is opaque. An unquoted `#` at the start of a word ends the line.
 * - A redirection (`<`, `>`, `>>`, `>&`, `<&`, `>|`, after optional digits) and its target, the
 *   rest of its word or else the next word, are not arguments; the words after them are.
 * - Not understood, so the whole script declares nothing: a carriage return anywhere (a shell
 *   passes it on inside a word), an unterminated quote, a backslash at the end, a here-document
 *   or here-string (`<<`), `<>`, `&>` (bash and `dash` read it differently), a command
 *   substitution (`$(` or a backtick) or a `${` expansion (its body is not read), in double
 *   quotes or not, an unquoted `(` or `)`, a redirection with no target, two redirections in a
 *   row, and an operator a shell refuses: `;`, `&`, `&&`, `||`, `|` or `|&` with no command before
 *   it, or `&&`, `||`, `|` or `|&` with none after it (a trailing `;` or line break is accepted,
 *   and a line break may follow `&&`, `||` or `|` before the next command).
 */
export const scriptCommands = (
  script: string,
): ReadonlyArray<ReadonlyArray<ScriptWord>> | undefined => {
  if (script.includes("\r")) return undefined;
  const commands: Array<Array<ScriptWord>> = [];
  let command: Array<ScriptWord> = [];
  let text = "";
  let inWord = false;
  let opaque = false;
  // The length of the word's text before its first quote or backslash; -1 while it has none.
  let bare = -1;
  // The next word is a redirection's target.
  let target = false;
  // The current command has a redirection, so it is not empty though it may have no word.
  let redirected = false;
  // An `&&`, `||`, `|` or `|&` was read, and the next command must not be empty.
  let needCommand = false;
  const endWord = () => {
    if (!inWord) return;
    const name = ASSIGNMENT.exec(text)?.[0].length;
    const word = {
      text,
      opaque,
      assignment: name !== undefined && name <= (bare < 0 ? text.length : bare),
    };
    if (target) target = false;
    else command.push(word);
    text = "";
    inWord = false;
    opaque = false;
    bare = -1;
  };
  const quoting = () => {
    if (bare < 0) bare = text.length;
    inWord = true;
  };
  /**
   * Ends the command at an operator, a line break or the end; false when a shell would refuse
   * the script there: a redirection left without its target, or an operator with no command
   * before it or, for `&&`, `||`, `|` and `|&`, after it.
   */
  const endCommand = (at: "and-or-pipe" | "list" | "line" | "end") => {
    endWord();
    if (target) return false;
    const empty = command.length === 0 && !redirected;
    if (empty) {
      if (at === "line") return true;
      if (at === "end") return !needCommand;
      return false;
    }
    commands.push(command);
    command = [];
    redirected = false;
    needCommand = at === "and-or-pipe";
    return true;
  };
  const length = script.length;
  let at = 0;
  while (at < length) {
    const char = script[at] ?? "";
    const next = script[at + 1];
    if (char === " " || char === "\t") {
      endWord();
      at++;
    } else if (char === "\n") {
      if (!endCommand("line")) return undefined;
      at++;
    } else if (char === ";") {
      if (!endCommand("list")) return undefined;
      at++;
    } else if (char === "|") {
      if (!endCommand("and-or-pipe")) return undefined;
      at += next === "|" || next === "&" ? 2 : 1;
    } else if (char === "&") {
      if (next === ">") return undefined;
      if (!endCommand(next === "&" ? "and-or-pipe" : "list")) return undefined;
      at += next === "&" ? 2 : 1;
    } else if (char === "<" || char === ">") {
      // A redirection. The digits of a word that holds only unquoted digits are its descriptor.
      if (inWord && bare < 0 && /^\d+$/.test(text)) {
        text = "";
        inWord = false;
      } else endWord();
      if (target) return undefined;
      const operator = char;
      const after = script[at + 1];
      if (operator === "<") {
        if (after === "<" || after === ">") return undefined;
        at += after === "&" ? 2 : 1;
      } else at += after === ">" || after === "&" || after === "|" ? 2 : 1;
      target = true;
      redirected = true;
    } else if (char === "#" && !inWord) {
      const end = script.indexOf("\n", at);
      at = end < 0 ? length : end;
    } else if (char === "\\") {
      if (next === undefined) return undefined;
      if (next !== "\n") {
        quoting();
        text += next;
      }
      at += 2;
    } else if (char === "'") {
      const end = script.indexOf("'", at + 1);
      if (end < 0) return undefined;
      quoting();
      text += script.slice(at + 1, end);
      at = end + 1;
    } else if (char === '"') {
      quoting();
      let end = at + 1;
      for (;;) {
        const inner = script[end];
        if (inner === undefined) return undefined;
        if (inner === '"') break;
        if (inner === "`") return undefined;
        if (inner === "$") {
          if (script[end + 1] === "(" || script[end + 1] === "{")
            return undefined;
          opaque = true;
        }
        if (inner === "\\") {
          const escaped = script[end + 1];
          if (escaped === undefined) return undefined;
          if (escaped === "\n") {
            end += 2;
            continue;
          }
          if ('$`"\\'.includes(escaped)) {
            text += escaped;
            end += 2;
            continue;
          }
        }
        text += inner;
        end++;
      }
      at = end + 1;
    } else if (char === "(" || char === ")" || char === "`") {
      return undefined;
    } else {
      if (char === "$" && (next === "(" || next === "{")) return undefined;
      if (
        char === "$" ||
        char === "*" ||
        char === "?" ||
        char === "[" ||
        char === "{" ||
        (char === "~" && !inWord)
      )
        opaque = true;
      inWord = true;
      text += char;
      at++;
    }
  }
  return endCommand("end") ? commands : undefined;
};

/** A test root a script gives, and the wrapper it runs when it is not `bun test`. */
export interface BunTestRoot {
  readonly root: string;
  readonly script: string;
  readonly wrapper?: { readonly path: string; readonly bunfig: string };
}

/**
 * A script as far as the reader follows it: the commands it follows (none when it follows none),
 * and, when it stopped, why, as the end of a sentence about the script (`uses --cwd, which the
 * reader does not follow`).
 */
interface ReadScript {
  readonly name: string;
  readonly commands: ReadonlyArray<ReadonlyArray<ScriptWord>>;
  readonly unfollowed?: string;
}

/** A manifest's scripts, each read into commands. */
type ManifestScripts = ReadonlyArray<ReadScript>;

/**
 * A manifest's scripts, or why they were not read (the end of a sentence about the manifest), and
 * what it says about other runners: the runner keys it holds (`RUNNER_MANIFEST_KEYS`) and whether
 * it names `vitest` in its scripts or dependencies.
 */
type ManifestRead = (
  { readonly scripts: ManifestScripts } | { readonly unread: string }
) & {
  readonly runnerKeys: ReadonlyArray<string>;
  readonly namesVitest: boolean;
  /** The runners of `GATED_RUNNERS` it names in its scripts or dependencies. */
  readonly namesRunners: ReadonlyArray<string>;
  /** Every script that is a string, as written, for the paths it names. */
  readonly scriptTexts: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
  }>;
};

/** Runners whose documented defaults count only in a package that names them. */
const GATED_RUNNERS = ["ava", "tap"];

const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** What a parsed manifest says about other runners. */
const runnersIn = (
  parsed: unknown,
): Pick<
  ManifestRead,
  "runnerKeys" | "namesVitest" | "namesRunners" | "scriptTexts"
> => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      runnerKeys: [],
      namesVitest: false,
      namesRunners: [],
      scriptTexts: [],
    };
  const object = parsed as Record<string, unknown>;
  const scripts = object["scripts"];
  const namesVitest =
    (typeof scripts === "object" &&
      scripts !== null &&
      Object.values(scripts).some(
        (script) => typeof script === "string" && /\bvitest\b/.test(script),
      )) ||
    DEPENDENCY_KEYS.some((key) => {
      const dependencies = object[key];
      return (
        typeof dependencies === "object" &&
        dependencies !== null &&
        Object.hasOwn(dependencies, "vitest")
      );
    });
  const names = (runner: string) =>
    (typeof scripts === "object" &&
      scripts !== null &&
      Object.values(scripts).some(
        (script) =>
          typeof script === "string" &&
          new RegExp(`(?:^|[\\s/])${runner}(?:$|\\s)`).test(script),
      )) ||
    DEPENDENCY_KEYS.some((key) => {
      const dependencies = object[key];
      return (
        typeof dependencies === "object" &&
        dependencies !== null &&
        Object.hasOwn(dependencies, runner)
      );
    });
  return {
    runnerKeys: RUNNER_MANIFEST_KEYS.filter((key) =>
      Object.hasOwn(object, key),
    ),
    namesVitest,
    namesRunners: GATED_RUNNERS.filter((runner) => names(runner)),
    scriptTexts:
      typeof scripts === "object" && scripts !== null
        ? Object.entries(scripts).flatMap(([name, text]) =>
            typeof text === "string" ? [{ name, text }] : [],
          )
        : [],
  };
};

/**
 * Command words whose effect on what runs, or where, the reader does not follow: shell reserved
 * words (compound commands, negation, `time`) and builtins that run another command or text.
 */
const UNFOLLOWED_COMMANDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "{",
  "}",
  "!",
  "[[",
  "]]",
  "builtin",
  "command",
  "eval",
  "exec",
  "source",
  ".",
]);
/** Words that change the directory the later commands run in. */
const CHANGES_DIRECTORY = new Set(["cd", "pushd", "popd"]);

/**
 * A script's commands, as far as the reader follows them. The whole script declares nothing when
 * `scriptCommands` does not understand it, or when any command's command word (after leading
 * assignments) is opaque or one the reader does not follow, or `env` with an option. From the
 * first command that holds `cd`, `pushd` or `popd` as any word, it and every later command
 * declare nothing; when one of those commands runs anything but `cd`, `pushd` or `popd`, the
 * script says it stopped there.
 */
const followedCommands = (script: string): Omit<ReadScript, "name"> => {
  const commands = scriptCommands(script);
  if (commands === undefined)
    return {
      commands: [],
      unfollowed: "uses shell syntax the reader does not parse",
    };
  for (const words of commands) {
    const at = words.findIndex((word) => !word.assignment);
    const head = words[at]?.text;
    if (head === undefined) continue;
    // A command word the shell would change may be any command, `cd` among them.
    if (words[at]?.opaque === true)
      return {
        commands: [],
        unfollowed:
          "has a command word the shell would change, which the reader does not follow",
      };
    if (UNFOLLOWED_COMMANDS.has(head))
      return {
        commands: [],
        unfollowed: `runs "${head}", which the reader does not follow`,
      };
    if (head === "env" && (words[at + 1]?.text.startsWith("-") ?? false))
      return {
        commands: [],
        unfollowed: "runs env with an option, which the reader does not follow",
      };
  }
  const moved = commands.findIndex((words) =>
    words.some((word) => CHANGES_DIRECTORY.has(word.text)),
  );
  if (moved < 0) return { commands };
  const followed = commands.slice(0, moved);
  // Only a change of directory itself runs nothing the reader would read.
  const runsMore = commands.slice(moved).some((words) => {
    const head = words.find((word) => !word.assignment);
    return (
      head !== undefined && (head.opaque || !CHANGES_DIRECTORY.has(head.text))
    );
  });
  if (!runsMore) return { commands: followed };
  const word =
    commands[moved]?.find((each) => CHANGES_DIRECTORY.has(each.text))?.text ??
    "cd";
  return {
    commands: followed,
    unfollowed: `changes directory with "${word}", and the reader does not follow the commands from there on`,
  };
};

/** A package manifest's scripts read into commands, or why they were not read. */
const manifestScripts = (manifestText: string): ManifestRead => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    // No runner reads a manifest that is not JSON either.
    return {
      unread: "is not valid JSON",
      runnerKeys: [],
      namesVitest: false,
      namesRunners: [],
      scriptTexts: [],
    };
  }
  const runners = runnersIn(parsed);
  const result = PackageManifest.safeParse(parsed);
  if (!result.success)
    return {
      unread: "is not an object whose scripts are all strings",
      ...runners,
    };
  return {
    ...runners,
    scripts: Object.entries(result.data.scripts ?? {}).map(
      ([name, script]) => ({ name, ...followedCommands(script) }),
    ),
  };
};

/** The words a manifest's followed commands hold, for the per-call budget. */
const wordsIn = (read: ManifestRead) => {
  let words = 0;
  if ("scripts" in read)
    for (const { commands } of read.scripts)
      for (const command of commands) words += command.length;
  return words;
};

/**
 * Which `by` a place gives beyond its own package. It decides nothing else: every test-named file
 * not declared a test is undecided wherever it is. `repository`: where the run goes is not known (a
 * change of directory, `--cwd`, a word the tree cannot confirm, a word or script the reader did
 * not see), so the first such place names the test-named files no place in their own package
 * names. `directory`: the place names only its own package's files.
 */
/**
 * `package`: also a word that may name any file as a test (an opaque positional word given to a
 * test runner), so every path in the package the script runs in (its manifest's directory, less
 * any nested directory with its own `package.json`) not otherwise settled is undecided by it.
 */
type StopScope = "directory" | "repository" | "package";

/** A place where the reader stopped, as the end of a sentence, and how far it reaches. */
interface Stopped {
  readonly unfollowed: string;
  readonly scope: StopScope;
}

/** A flag written with its value (`--timeout=$T`): the shell can change only the value. */
const FLAG_WITH_VALUE = /^--?[A-Za-z][A-Za-z0-9-]*=/;

/**
 * Among a runner's arguments, a word that leaves where the run goes unknown: `--cwd`, which moves
 * it, or a word the shell would change. An opaque positional word may become any path, so it may
 * name any file in the package (`package`); an opaque flag value written as `--flag=$X` changes only the flag.
 * Every word is looked at, before any other rule can end the reading.
 */
const directoryUnknown = (
  words: ReadonlyArray<ScriptWord>,
): Stopped | undefined => {
  if (
    words.some(
      (word) => word.text === "--cwd" || word.text.startsWith("--cwd="),
    )
  )
    return {
      unfollowed: "uses --cwd, which the reader does not follow",
      scope: "repository",
    };
  let flags = true;
  let opaqueValue = false;
  for (const word of words) {
    if (flags && !word.opaque && word.text === "--") {
      flags = false;
      continue;
    }
    if (!word.opaque) continue;
    if (flags && FLAG_WITH_VALUE.test(word.text)) {
      opaqueValue = true;
      continue;
    }
    return {
      unfollowed:
        "passes Bun's test runner a word the shell would change, which the reader does not follow",
      scope: "package",
    };
  }
  if (opaqueValue)
    return {
      unfollowed:
        "passes Bun's test runner a flag value the shell would change, which the reader does not follow",
      scope: "repository",
    };
  return undefined;
};

/** A word Bun's test runner reads as a path rather than a filter. */
const isPathWord = (text: string) =>
  text.startsWith("./") || text.startsWith("../") || text.startsWith("/");

/**
 * The roots a command's arguments name (rules at `bunTestRoots`): the package's directory when
 * they name none, and why not when a word is one the reader does not follow.
 */
const argumentRoots = (
  words: ReadonlyArray<ScriptWord>,
  directory: string,
  tree: TreePaths,
):
  | {
      readonly roots: ReadonlyArray<string>;
      /** The words named the roots; false when the root is the package's directory by default. */
      readonly named: boolean;
    }
  | Stopped => {
  // A word the shell would change may become several words, flags or paths; `--cwd` moves the
  // run to another directory. Either anywhere among the words: not understood.
  const unknown = directoryUnknown(words);
  if (unknown !== undefined) return unknown;
  const roots: Array<string> = [];
  let named = false;
  let flags = true;
  let afterFlag = false;
  // `--path-ignore-patterns` takes files out of what Bun runs, and the reader does not apply
  // patterns. It only narrows inside the roots the words name, so the words after it are still
  // read: one the tree cannot confirm may name a place outside the package.
  let ignores = false;
  for (const word of words) {
    if (
      word.text === "--path-ignore-patterns" ||
      word.text.startsWith("--path-ignore-patterns=")
    ) {
      ignores = true;
      afterFlag = !word.text.includes("=");
      continue;
    }
    const valueOf = afterFlag;
    afterFlag = false;
    if (flags && word.text === "--") {
      flags = false;
      continue;
    }
    if (flags && word.text.startsWith("-")) {
      afterFlag = !word.text.includes("=");
      continue;
    }
    // Bun takes a word as a path only when it starts with `./`, `../` or `/`; any other word is a
    // filter on the paths of the test files under the directory it runs in (`bun test tests` runs
    // `src/unit-tests/b_test.ts` too). A filter narrows nothing the reader declares.
    if (!isPathWord(word.text)) continue;
    const path = resolveIn(directory, word.text);
    const kind = path === undefined ? undefined : tree.kindOf(path);
    if (path !== undefined && (kind === "file" || kind === "directory")) {
      roots.push(path);
      continue;
    }
    // A submodule link, or a path under one, is named but holds nothing in this tree.
    if (kind === "link") {
      named = true;
      continue;
    }
    if (valueOf) continue;
    // A word the tree cannot confirm may name a place outside the package (`../shared/tests`,
    // or a path through a missing directory that climbs out), so where the run goes is not known.
    return {
      unfollowed:
        "passes Bun's test runner a word that is not a path in the tree, which the reader does not follow",
      scope: "repository",
    };
  }
  if (ignores)
    return {
      unfollowed:
        "uses --path-ignore-patterns, which the reader does not follow",
      scope: "directory",
    };
  return roots.length === 0 && !named
    ? { roots: [directory], named: false }
    : { roots, named: true };
};

/**
 * The roots each package manifest's scripts give Bun's test runner, resolved against the
 * manifest's directory. Each script is read into commands by `scriptCommands`; a script it does not
 * fully understand declares nothing, and so does one with a command word the reader does not
 * follow (a reserved word, `builtin`, `command`, `eval`, `exec`, `source`, `.`, or `env` with an
 * option). From the first command holding `cd`, `pushd` or `popd` as any word, the rest of the
 * script declares nothing, since the roots would no longer be under the manifest's directory. In
 * each command:
 *
 * - leading `NAME=value` words are skipped, and the command is the next word;
 * - it runs the runner as `bun <file>` when the command is `bun` and `<file>` is the file the
 *   `bunfig.toml` in the manifest's own directory names in `[test].preload` and the tree has, or
 *   as `bun test` anywhere in it; no opaque word counts for either;
 * - when the manifest's `bunfig.toml` sets `[test].root` or `[test].pathIgnorePatterns`, or the
 *   reader cannot see its `[test]` table (unreadable, over 64 KiB, not valid TOML, or a `test`
 *   value that is not a table), no command declares anything;
 * - the later words are read in order: an opaque word, `--cwd` or `--path-ignore-patterns` makes
 *   the command declare nothing; `--` ends the flags; before it, a word starting with `-` is a flag; a word that is a
 *   file or directory in `tree` is a root, and one that is a submodule link or under one is named
 *   and holds nothing; any other word directly after a flag with no `=` may be that flag's value
 *   and is ignored; any other word is unconfirmed, and the command declares nothing;
 * - with no root, nothing named and nothing unconfirmed, the root is the package's directory.
 */
export const bunTestRoots = (
  manifestPath: string,
  manifestText: string,
  context: ScriptContext,
): ReadonlyArray<BunTestRoot> => {
  const read = manifestScripts(manifestText);
  return "scripts" in read
    ? scriptRoots(manifestPath, read.scripts, context).roots
    : [];
};

/** The `bunfig.toml` in a manifest's directory, as the reader saw it. */
export interface BesideBunfig {
  readonly path: string;
  readonly preloads: ReadonlyArray<string>;
  /** Its `[test]` table sets `root` or `pathIgnorePatterns`, or the reader cannot see it. */
  readonly narrows?: boolean;
  /** When it narrows: what the reader saw, as the end of a sentence about the file. */
  readonly why?: string;
  /**
   * The reader does not know its `[test].preload` (it cannot see the table, or the file is a
   * symbolic link it does not follow), as the end of a sentence about the file.
   */
  readonly preloadsUnknown?: string;
}

export interface ScriptContext {
  readonly tree: TreePaths;
  readonly bunfig?: BesideBunfig;
}

/** A script the reader stopped following, why (the end of a sentence about it) and how far. */
interface Unfollowed extends Stopped {
  readonly script: string;
}

const scriptRoots = (
  manifestPath: string,
  scripts: ManifestScripts,
  context: ScriptContext,
): {
  readonly roots: ReadonlyArray<BunTestRoot>;
  readonly unfollowed: ReadonlyArray<Unfollowed>;
  /** The roots a script's words name, as against the package's directory by default. */
  readonly namedRoots: ReadonlyArray<{
    readonly root: string;
    readonly script: string;
  }>;
} => {
  const directory = directoryOf(manifestPath);
  const { tree, bunfig } = context;
  const plain = (word: ScriptWord | undefined, text: string) =>
    word !== undefined && !word.opaque && word.text === text;
  const fileOf = (word: ScriptWord | undefined) => {
    if (word === undefined || word.opaque) return undefined;
    const path = resolveIn(directory, word.text);
    return path !== undefined && tree.kindOf(path) === "file"
      ? path
      : undefined;
  };
  const roots: Array<BunTestRoot> = [];
  const unfollowed: Array<Unfollowed> = [];
  const namedRoots: Array<{ root: string; script: string }> = [];
  const seen = new Set<string>();
  const stopped = new Set<string>();
  /**
   * Where a runner's words may send the run when the reader does not follow the command for
   * another reason (a narrowing `bunfig.toml`, a wrapper it cannot confirm): the stop the words
   * themselves give when it reaches the whole repository, and nothing otherwise.
   */
  const reachOf = (rest: ReadonlyArray<ScriptWord>): Stopped | undefined => {
    const named = argumentRoots(rest, directory, tree);
    return "unfollowed" in named && named.scope !== "directory"
      ? named
      : undefined;
  };
  const stop = (script: string, why: string, scope: StopScope) => {
    const key = JSON.stringify([script, why, scope]);
    if (stopped.has(key)) return;
    stopped.add(key);
    unfollowed.push({ script, unfollowed: why, scope });
  };
  for (const { name, commands, unfollowed: why } of scripts) {
    // A script the reader stopped reading may run anything anywhere, a change of directory
    // among it.
    if (why !== undefined) stop(name, why, "repository");
    for (const words of commands) {
      // `bun` before a word the shell would change may run `bun test` or a test wrapper, in any
      // directory, on any file the word becomes.
      if (
        words.some(
          (word, index) =>
            plain(word, "bun") && words[index + 1]?.opaque === true,
        )
      )
        stop(
          name,
          "passes bun a word the shell would change, which the reader does not follow",
          "package",
        );
      // `bun` with a flag before its command (`bun --cwd .. test`) may run the test runner when a
      // later word is `test` or could be the test wrapper; the reader reads neither form there.
      // A flag before any other file (`bun --no-env-file ./cli.ts`) runs that file, not tests.
      // One pass from the right: whether any word from each index on may run the test runner.
      // A word the shell would change may be `test` itself (`bun --silent $MODE`).
      const runnerFrom = new Array<boolean>(words.length + 1).fill(false);
      for (let index = words.length - 1; index >= 0; index--) {
        const later = words[index];
        let runs =
          later !== undefined && (later.opaque || plain(later, "test"));
        if (!runs && bunfig !== undefined) {
          const file = fileOf(later);
          runs =
            file !== undefined &&
            (bunfig.preloadsUnknown !== undefined ||
              bunfig.preloads.includes(file));
        }
        runnerFrom[index] = runs || (runnerFrom[index + 1] ?? false);
      }
      const flagged = words.findIndex(
        (word, index) =>
          plain(word, "bun") &&
          words[index + 1]?.opaque === false &&
          words[index + 1]?.text.startsWith("-") === true &&
          (runnerFrom[index + 2] ?? false),
      );
      // Which of its words are paths is not read either, so the run may go anywhere.
      if (flagged >= 0) {
        const unknown = directoryUnknown(words.slice(flagged + 1));
        stop(
          name,
          unknown?.unfollowed ??
            "passes bun a flag before its command, which the reader does not follow",
          unknown?.scope === "package" ? "package" : "repository",
        );
      }
      const command = words.findIndex((word) => !word.assignment);
      let at = command;
      const candidate =
        command >= 0 &&
        plain(words[command], "bun") &&
        !plain(words[command + 1], "test")
          ? fileOf(words[command + 1])
          : undefined;
      // The wrapper is a file the `bunfig.toml` beside the manifest names in `[test].preload`.
      if (candidate !== undefined && bunfig?.preloadsUnknown !== undefined) {
        const unknown = reachOf(words.slice(command + 2));
        stop(
          name,
          unknown?.unfollowed ??
            `runs bun with a file beside ${bunfig.path}, which ${bunfig.preloadsUnknown}, so the reader cannot tell whether that file is a test wrapper`,
          unknown?.scope ?? "directory",
        );
      }
      const wrapper =
        candidate !== undefined &&
        bunfig !== undefined &&
        bunfig.preloads.includes(candidate)
          ? { path: candidate, bunfig: bunfig.path }
          : undefined;
      if (wrapper === undefined)
        at = words.findIndex(
          (word, index) =>
            plain(word, "bun") && plain(words[index + 1], "test"),
        );
      if (at < 0) continue;
      // Bun reads the `bunfig.toml` of the directory it runs in, the manifest's: a `[test]` table
      // that narrows what Bun runs, which the reader does not apply, leaves the command no tests.
      if (bunfig?.narrows === true) {
        const unknown = reachOf(words.slice(at + 2));
        stop(
          name,
          unknown?.unfollowed ??
            `runs Bun's test runner beside ${bunfig.path}, which ${bunfig.why ?? "may narrow what Bun runs"}, so the reader does not follow it`,
          unknown?.scope ?? "directory",
        );
        continue;
      }
      const named = argumentRoots(words.slice(at + 2), directory, tree);
      if ("unfollowed" in named) {
        stop(name, named.unfollowed, named.scope);
        continue;
      }
      for (const root of named.roots) {
        if (named.named) namedRoots.push({ root, script: name });
        const key = JSON.stringify([root, name, wrapper?.path ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        roots.push(
          wrapper === undefined
            ? { root, script: name }
            : { root, script: name, wrapper },
        );
      }
    }
  }
  return { roots, unfollowed, namedRoots };
};

/**
 * A test runner the reader does not read, and the files its own documentation says it runs by
 * default. A file matching one is never made a test by it: the reader cannot tell whether that
 * runner runs in the repository, so the file is only undecided (`testStatusOf`).
 */
export interface TestConvention {
  readonly runner: string;
  /** The page that documents the default. */
  readonly documentation: string;
  /** Each default pattern as the documentation writes it, and the same rule over a path. */
  readonly rules: ReadonlyArray<{
    readonly pattern: string;
    readonly path: RegExp;
  }>;
  /**
   * The runner whose defaults these are, when they count only in a package whose `package.json`
   * names it in its scripts or dependencies (or was not read); the rules then match the path
   * below that package's directory.
   */
  readonly when?: "ava" | "tap";
}

/** Any directories, then a file name: the `**\/` of a glob, at the root or below. */
const ANYWHERE = "(?:^|/)";
const fileRule = (name: string) => new RegExp(`${ANYWHERE}${name}$`);

/**
 * The pinned list of runners' documented default test files (checked on 13 November 2026 against
 * each page named). Never a repository's own path. Every file Vitest's default names is also named
 * like a Bun test, so Bun's rule names it first. Go's rule leaves out names starting with `_` or
 * `.`, which its documentation says are ignored. Widened in round 12c to the current
 * documentation: Jest's `.mjs`/`.cjs`/`.mts`/`.cts`, Node's TypeScript patterns, and every Gradle
 * test source set under `src/test/`.
 */
export const TEST_CONVENTIONS: ReadonlyArray<TestConvention> = [
  {
    runner: "Jest",
    documentation: "https://jestjs.io/docs/configuration#testmatch-arraystring",
    rules: [
      {
        pattern: "**/__tests__/**/*.?([mc])[jt]s?(x)",
        path: /(?:^|\/)__tests__\/(?:.*\/)?[^/]*\.[mc]?[jt]sx?$/,
      },
      {
        pattern: "**/?(*.)+(spec|test).?([mc])[jt]s?(x)",
        path: fileRule("(?:[^/]*\\.)?(?:spec|test)+\\.[mc]?[jt]sx?"),
      },
    ],
  },
  {
    runner: "Vitest",
    documentation: "https://vitest.dev/config/include",
    rules: [
      {
        pattern: "**/*.{test,spec}.?(c|m)[jt]s?(x)",
        path: fileRule("[^/]*\\.(?:test|spec)\\.[cm]?[jt]sx?"),
      },
    ],
  },
  {
    runner: "Node's test runner",
    documentation:
      "https://nodejs.org/api/test.html#running-tests-from-the-command-line",
    rules: [
      ...(["js", "ts"] as const).flatMap((suffix) => [
        {
          pattern: `**/*.test.?(c|m)${suffix}`,
          path: fileRule(`[^/]*\\.test\\.[cm]?${suffix}`),
        },
        {
          pattern: `**/*-test.?(c|m)${suffix}`,
          path: fileRule(`[^/]*-test\\.[cm]?${suffix}`),
        },
        {
          pattern: `**/*_test.?(c|m)${suffix}`,
          path: fileRule(`[^/]*_test\\.[cm]?${suffix}`),
        },
        {
          pattern: `**/test-*.?(c|m)${suffix}`,
          path: fileRule(`test-[^/]*\\.[cm]?${suffix}`),
        },
        {
          pattern: `**/test.?(c|m)${suffix}`,
          path: fileRule(`test\\.[cm]?${suffix}`),
        },
        {
          pattern: `**/test/**/*.?(c|m)${suffix}`,
          path: new RegExp(`(?:^|/)test/(?:.*/)?[^/]*\\.[cm]?${suffix}$`),
        },
      ]),
    ],
  },
  {
    runner: "pytest",
    documentation:
      "https://docs.pytest.org/en/stable/reference/reference.html#confval-python_files",
    rules: [
      { pattern: "test_*.py", path: fileRule("test_[^/]*\\.py") },
      { pattern: "*_test.py", path: fileRule("[^/]*_test\\.py") },
    ],
  },
  {
    runner: "Go",
    documentation: "https://pkg.go.dev/cmd/go#hdr-Test_packages",
    rules: [{ pattern: "*_test.go", path: fileRule("[^/._][^/]*_test\\.go") }],
  },
  {
    runner: "RSpec",
    documentation:
      "https://rspec.info/features/3-13/rspec-core/configuration/pattern/",
    rules: [{ pattern: "**/*_spec.rb", path: fileRule("[^/]*_spec\\.rb") }],
  },
  {
    runner: "Maven and Gradle",
    documentation:
      "https://maven.apache.org/guides/introduction/introduction-to-the-standard-directory-layout.html, https://docs.gradle.org/current/userguide/java_plugin.html and https://docs.gradle.org/current/userguide/groovy_plugin.html",
    rules: [
      {
        pattern: "src/test/**",
        path: /(?:^|\/)src\/test\/(?:.*\/)?[^/]+$/,
      },
    ],
  },
  {
    runner: "AVA",
    documentation:
      "https://github.com/avajs/ava/blob/main/docs/06-configuration.md (defaultTestPatterns in lib/globs.js)",
    when: "ava",
    rules: [
      { pattern: "test.{js,cjs,mjs}", path: /^test\.[cm]?js$/ },
      {
        pattern: "{src,source}/test.{js,cjs,mjs}",
        path: /^(?:src|source)\/test\.[cm]?js$/,
      },
      {
        pattern: "**/__tests__/**/*.{js,cjs,mjs}",
        path: /(?:^|\/)__tests__\/(?:.*\/)?[^/]*\.[cm]?js$/,
      },
      {
        pattern: "**/*.spec.{js,cjs,mjs}",
        path: fileRule("[^/]*\\.spec\\.[cm]?js"),
      },
      {
        pattern: "**/*.test.{js,cjs,mjs}",
        path: fileRule("[^/]*\\.test\\.[cm]?js"),
      },
      {
        pattern: "**/test-*.{js,cjs,mjs}",
        path: fileRule("test-[^/]*\\.[cm]?js"),
      },
      {
        pattern: "**/test/**/*.{js,cjs,mjs}",
        path: /(?:^|\/)test\/(?:.*\/)?[^/]*\.[cm]?js$/,
      },
      {
        pattern: "**/tests/**/*.{js,cjs,mjs}",
        path: /(?:^|\/)tests\/(?:.*\/)?[^/]*\.[cm]?js$/,
      },
    ],
  },
  {
    runner: "tap",
    documentation: "https://node-tap.org/cli/",
    when: "tap",
    rules: [
      {
        pattern: "{test,tests,__tests__}/** (top-level folders)",
        path: /^(?:test|tests|__tests__)\/(?:.*\/)?[^/]*\.[cm]?[jt]sx?$/,
      },
      {
        pattern: "**/*.{spec,test}.<ext>",
        path: fileRule("[^/]*\\.(?:spec|test)\\.[cm]?[jt]sx?"),
      },
      {
        pattern: "{test,tests}.<ext> (top-level files)",
        path: /^tests?\.[cm]?[jt]sx?$/,
      },
    ],
  },
];

/** Part of every key that depends on `TEST_CONVENTIONS` or `RUNNER_CONFIGS` (only `undecided`). */
export const TEST_CONVENTIONS_RECIPE = "neuve-test-conventions-v3";

/** The `by` of a file named like a Bun test that no followed script declares a test. */
export const BUN_NAMED_BY =
  "test-conventions: named like a Bun test (Bun's test-file rule), and no followed script declares it a test";

/** The first convention rule a path matches, as a `by`. */
const conventionOf = (path: string): string | undefined => {
  for (const { runner, rules, when } of TEST_CONVENTIONS) {
    if (when !== undefined) continue;
    for (const { pattern, path: rule } of rules)
      if (rule.test(path))
        return `test-conventions: matches ${runner}'s default test files (${pattern}), a runner the reader does not read`;
  }
  return undefined;
};

/**
 * The first default of a runner that counts only where a package names it (`TestConvention.when`)
 * that a path below its package's directory matches, as a `by`.
 */
const gatedConventionOf = (
  path: string,
  packages: ReadonlyArray<string>,
  runnersAt: ReadonlyMap<
    string,
    { readonly namesRunners: ReadonlyArray<string> } | undefined
  >,
): string | undefined => {
  // Every package at or above the path, nearest first: a runner run from an outer package globs
  // its workspaces too (AVA's defaults reach any depth; tap's folders are top-level, so their
  // rule, read below that package, covers only its own).
  for (const pkg of packages) {
    const runners = runnersAt.get(pkg);
    const below = pkg === "" ? path : path.slice(pkg.length + 1);
    for (const { runner, rules, when } of TEST_CONVENTIONS) {
      if (when === undefined) continue;
      // A manifest that was not read may name any runner.
      if (runners !== undefined && !runners.namesRunners.includes(when))
        continue;
      for (const { pattern, path: rule } of rules)
        if (rule.test(below))
          return `test-conventions: matches ${runner}'s default test files (${pattern}) in a package that names ${runner}, a runner the reader does not read`;
    }
  }
  return undefined;
};

/**
 * A runner's configuration file the reader does not read. Such a file can name any file as a
 * test, so every path under the directory it configures that is not declared a test is undecided.
 */
export interface RunnerConfig {
  readonly runner: string;
  /** The page that documents the file names. */
  readonly documentation: string;
  /** The file names, as the documentation lists them, and the same rule over a file's name. */
  readonly names: string;
  readonly name: RegExp;
  /**
   * `vitest`: the file counts only where the same directory's `package.json` names `vitest` in
   * its scripts or dependencies (Vitest reads `vite.config.*`; Vite alone runs no tests).
   * `python_files`: only when its text sets `python_files` (pytest reads its section there).
   */
  readonly when?: "vitest" | "python_files";
}

/**
 * The pinned list of runner configuration files (checked on 13 November 2026 against each page
 * named). A file in a `.config` directory (Karma's documented second place) configures the
 * directory above it. The `jest`, `ava` and `mocha` keys of a `package.json` count too
 * (`RUNNER_MANIFEST_KEYS`).
 */
export const RUNNER_CONFIGS: ReadonlyArray<RunnerConfig> = [
  {
    runner: "Jest",
    documentation: "https://jestjs.io/docs/configuration",
    names: "jest.config.{js,ts,mjs,mts,cjs,cts,json}",
    name: /^jest\.config\.(?:[cm]?[jt]s|json)$/,
  },
  {
    runner: "Vitest",
    documentation: "https://vitest.dev/config/",
    names: "vitest.config.{ts,mts,cts,js,mjs,cjs}",
    name: /^vitest\.config\.[cm]?[jt]s$/,
  },
  {
    runner: "Vitest",
    documentation: "https://vitest.dev/guide/workspace",
    names: "vitest.workspace.*",
    name: /^vitest\.workspace\.[^/]+$/,
  },
  {
    runner: "Vitest",
    documentation: "https://vitest.dev/config/",
    names:
      "vite.config.{ts,mts,cts,js,mjs,cjs}, beside a package.json that names vitest",
    name: /^vite\.config\.[cm]?[jt]s$/,
    when: "vitest",
  },
  {
    runner: "Playwright",
    documentation: "https://playwright.dev/docs/test-cli",
    names: "playwright.config.*",
    name: /^playwright\.config\.[^/]+$/,
  },
  {
    runner: "Mocha",
    documentation: "https://mochajs.org/running/configuring/",
    names: ".mocharc.{cjs,js,mjs,yaml,yml,jsonc,json}",
    name: /^\.mocharc\.[^/]+$/,
  },
  {
    runner: "Karma",
    documentation:
      "https://karma-runner.github.io/latest/config/configuration-file.html",
    names: "karma.conf.{js,coffee,ts}",
    name: /^karma\.conf\.[^/]+$/,
  },
  {
    runner: "AVA",
    documentation:
      "https://github.com/avajs/ava/blob/main/docs/06-configuration.md",
    names: "ava.config.*",
    name: /^ava\.config\.[^/]+$/,
  },
  {
    runner: "pytest",
    documentation: "https://docs.pytest.org/en/stable/reference/customize.html",
    names: "pytest.toml, .pytest.toml, pytest.ini, .pytest.ini",
    name: /^\.?pytest\.(?:toml|ini)$/,
  },
  {
    runner: "pytest",
    documentation: "https://docs.pytest.org/en/stable/reference/customize.html",
    names: "pyproject.toml, tox.ini or setup.cfg that sets python_files",
    name: /^(?:pyproject\.toml|tox\.ini|setup\.cfg)$/,
    when: "python_files",
  },
];

/** The `package.json` keys that hold a runner's configuration (Jest, AVA and Mocha read them). */
export const RUNNER_MANIFEST_KEYS = ["jest", "ava", "mocha"] as const;

/** The largest file read to see whether it sets `python_files`; a larger one counts as setting it. */
const PYTHON_CONFIG_BYTES = 1_048_576;

/**
 * Folders a runner's documented convention fixes as holding tests or their mocks, for every
 * repository: every file under one is undecided, whatever its name (Node's `test/` folder is in
 * `TEST_CONVENTIONS`). No other folder name counts.
 */
export const TEST_FOLDERS = Object.freeze([
  {
    id: "jest-tests-folder",
    pattern: String.raw`(^|/)__tests__/`,
    convention:
      "Jest's default testMatch runs the files in any __tests__ folder",
    documentation: "Jest: configuration, testMatch",
  },
  {
    id: "jest-mocks-folder",
    pattern: String.raw`(^|/)__mocks__/`,
    convention:
      "Jest reads a manual mock from a __mocks__ folder beside the module it mocks",
    documentation: "Jest: manual mocks",
  },
] as const);

const TEST_FOLDER_REGEXPS = TEST_FOLDERS.map((entry) => ({
  entry,
  regexp: new RegExp(entry.pattern, "u"),
}));

/** The `by` of the first test folder a path lies in. */
const testFolderOf = (path: string): string | undefined => {
  const entry = TEST_FOLDER_REGEXPS.find(({ regexp }) =>
    regexp.test(path),
  )?.entry;
  return entry === undefined
    ? undefined
    : `test-conventions: in a test folder (${entry.id}): ${entry.convention}`;
};

/**
 * A test runner's command the reader does not read, whose positional arguments name the test
 * files or folders it runs. The reader never runs it; it reads the words a script gives it.
 */
export interface RunnerCommand {
  readonly runner: string;
  /** The page that documents its positional arguments. */
  readonly documentation: string;
  /** The words that start the command, in order. */
  readonly words: ReadonlyArray<string>;
  /** A flag that must be among its words (`node` runs tests only with `--test`). */
  readonly needs?: string;
  /** Subcommands that may follow, which are not paths. */
  readonly subcommands?: ReadonlyArray<string>;
  /**
   * Its documented flags that change which files it collects (alone or written `--flag=value`):
   * any one reaches the whole package. The paths they name count as any script word's do.
   */
  readonly collects?: ReadonlyArray<string>;
}

/** pytest's flags that change what it collects (its usage, doctest and plugin pages). */
const PYTEST_COLLECTS = [
  "-o",
  "--override-ini",
  "--doctest-modules",
  "--doctest-glob",
  "-p",
  "--rootdir",
];

/** The pinned list (checked on 13 November 2026 against each page named). */
export const RUNNER_COMMANDS: ReadonlyArray<RunnerCommand> = [
  {
    runner: "Node's test runner",
    documentation:
      "https://nodejs.org/api/test.html#running-tests-from-the-command-line",
    words: ["node"],
    needs: "--test",
  },
  {
    runner: "Mocha",
    documentation: "https://mochajs.org/running/cli/",
    words: ["mocha"],
    collects: ["--extension", "--recursive", "--spec", "--file"],
  },
  {
    runner: "Jest",
    documentation: "https://jestjs.io/docs/cli",
    words: ["jest"],
    collects: [
      "--testMatch",
      "--testRegex",
      "--roots",
      "--rootDir",
      "--testPathPattern",
    ],
  },
  {
    runner: "Vitest",
    documentation: "https://vitest.dev/guide/cli",
    words: ["vitest"],
    subcommands: ["run", "watch", "dev", "related", "bench"],
    collects: ["--dir", "--root"],
  },
  {
    runner: "Playwright",
    documentation: "https://playwright.dev/docs/test-cli",
    words: ["playwright", "test"],
  },
  {
    runner: "AVA",
    documentation:
      "https://github.com/avajs/ava/blob/main/docs/05-command-line.md",
    words: ["ava"],
  },
  { runner: "tap", documentation: "https://node-tap.org/cli/", words: ["tap"] },
  {
    runner: "pytest",
    documentation: "https://docs.pytest.org/en/stable/how-to/usage.html",
    words: ["pytest"],
    collects: PYTEST_COLLECTS,
  },
  {
    runner: "pytest",
    documentation: "https://docs.pytest.org/en/stable/how-to/usage.html",
    words: ["python", "-m", "pytest"],
    collects: PYTEST_COLLECTS,
  },
  {
    runner: "pytest",
    documentation: "https://docs.pytest.org/en/stable/how-to/usage.html",
    words: ["python3", "-m", "pytest"],
    collects: PYTEST_COLLECTS,
  },
];

/** What a script's runner commands name: paths the tree confirms, and the package-wide cases. */
interface RunnerCommandsRead {
  readonly named: ReadonlyArray<{ readonly path: string; readonly by: string }>;
  readonly packageWide: ReadonlyArray<string>;
}

/**
 * The paths a manifest's followed scripts give a `RUNNER_COMMANDS` runner, read with the same
 * words and refusals as `bun test`. A command matches wherever its words appear in a command
 * (after `npx`, `cross-env X=1`, or anything else). After its words and any subcommand: `--`
 * ends the flags; `--config`, `--config=` or `-c` names a configuration the reader does not read,
 * and an opaque word (other than a flag's value written as `--flag=$X`) may become any path, so
 * both reach the whole package; a word the tree confirms as a file or directory is named; a word
 * directly after a flag with no `=` may be its value and is ignored; any other word is a path the
 * tree does not confirm, which reaches the whole package too.
 */
const runnerCommandsOf = (
  manifestPath: string,
  scripts: ManifestScripts,
  tree: TreePaths,
): RunnerCommandsRead => {
  const directory = directoryOf(manifestPath);
  const named: Array<{ path: string; by: string }> = [];
  const packageWide: Array<string> = [];
  const plain = (word: ScriptWord | undefined, text: string) =>
    word !== undefined && !word.opaque && word.text === text;
  for (const { name, commands } of scripts)
    for (const words of commands)
      for (const command of RUNNER_COMMANDS) {
        // The first place its words start, and (one pass) the last place its needed flag is.
        const start = words.findIndex((_, index) =>
          command.words.every((text, at) => plain(words[index + at], text)),
        );
        if (start < 0) continue;
        if (command.needs !== undefined) {
          let need = -1;
          for (let index = words.length - 1; index >= 0; index--)
            if (plain(words[index], command.needs)) {
              need = index;
              break;
            }
          if (need < start + command.words.length) continue;
        }
        let rest = words.slice(start + command.words.length);
        if (command.subcommands?.some((text) => plain(rest[0], text)) === true)
          rest = rest.slice(1);
        const at = `runner-commands: ${manifestPath} script "${name}" runs ${command.runner}`;
        const wide = (what: string) =>
          packageWide.push(
            `${at} with ${what}, so any file in the package may be one of its tests`,
          );
        let flags = true;
        let afterFlag = false;
        for (const word of rest) {
          if (word.opaque) {
            if (flags && FLAG_WITH_VALUE.test(word.text)) continue;
            wide("a word the shell would change");
            break;
          }
          if (flags && word.text === "--") {
            flags = false;
            continue;
          }
          const flag = word.text.split("=")[0] ?? "";
          if (
            flags &&
            (flag === "--config" ||
              word.text === "-c" ||
              (command.collects?.includes(flag) ?? false))
          ) {
            wide(
              flag === "--config" || flag === "-c"
                ? `${flag}, a configuration the reader does not read`
                : `${flag}, which changes the files it collects`,
            );
            break;
          }
          const valueOf = afterFlag;
          afterFlag = false;
          if (flags && word.text.startsWith("-")) {
            afterFlag = !word.text.includes("=");
            continue;
          }
          const path = resolveIn(directory, word.text);
          const kind = path === undefined ? undefined : tree.kindOf(path);
          if (path !== undefined && (kind === "file" || kind === "directory")) {
            named.push({
              path,
              by: `${at} on ${path}, a runner the reader does not read`,
            });
            continue;
          }
          if (kind === "link" || valueOf) continue;
          wide("a path the tree does not confirm");
          break;
        }
      }
  return { named, packageWide };
};

/**
 * Commands that never run tests, by the program a command runs once its launchers are taken off
 * (`npx`, `bunx`, `bun x`, `cross-env`, `env`, `pnpm exec`, leading `NAME=value` words). Each is
 * named; nothing is inferred. A script word given to one of these names no test. Every other
 * command counts its words (`SCRIPT_PATHS`).
 */
export const NEVER_RUNS_TESTS = Object.freeze([
  { program: "prettier", why: "formats files" },
  { program: "eslint", why: "lints files" },
  { program: "biome", why: "formats and lints files" },
  { program: "tsc", why: "type-checks or compiles TypeScript" },
  { program: "tsgo", why: "type-checks TypeScript (the native port of tsc)" },
  {
    program: "vite",
    why: "serves or builds an app; Vitest, a separate command, runs tests",
  },
  { program: "wrangler", why: "runs or deploys a Cloudflare Worker" },
  { program: "tsr", why: "generates TanStack Router's route tree" },
  {
    program: "bun run",
    why: "runs a package script by name, which the reader reads in its own manifest; the words after the name are passed on to that script, so they count",
  },
  { program: "bun build", why: "bundles files" },
  { program: "bun install", why: "installs packages" },
  { program: "bun add", why: "adds a package" },
  { program: "bun remove", why: "removes a package" },
  { program: "go build", why: "compiles Go packages" },
  { program: "go vet", why: "checks Go source" },
  { program: "go fmt", why: "formats Go source" },
  { program: "echo", why: "prints its words" },
  { program: "printf", why: "prints its words" },
  { program: "rm", why: "removes files" },
  { program: "mkdir", why: "makes directories" },
  { program: "cp", why: "copies files" },
  { program: "mv", why: "moves files" },
  { program: "touch", why: "touches files" },
  { program: "chmod", why: "changes file modes" },
] as const);

const NEVER_PROGRAMS: ReadonlySet<string> = new Set(
  NEVER_RUNS_TESTS.map((entry) => entry.program),
);

/** Shell words that open or close a compound command, before the command they hold. */
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "in",
  "case",
  "esac",
  "!",
  "{",
  "}",
  "time",
]);

/** Launchers that run the next word's program. */
const LAUNCHERS = new Set([
  "npx",
  "bunx",
  "cross-env",
  "env",
  "nohup",
  "exec",
  "command",
  "builtin",
]);

/**
 * A script cut into commands of words without refusing anything: quotes removed, an operator, a
 * line break, a parenthesis or a backtick ends a command, a redirection ends a word. A word holding
 * `$` or a backtick, or starting with `~`, is opaque. Used only to find the paths a script names,
 * where reading more words only withholds more.
 */
const looseCommands = (script: string): Array<Array<ScriptWord>> => {
  const commands: Array<Array<ScriptWord>> = [];
  let command: Array<ScriptWord> = [];
  let text = "";
  let inWord = false;
  let opaque = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord)
      command.push({
        text,
        opaque,
        assignment:
          ASSIGNMENT.test(text) && command.every((word) => word.assignment),
      });
    text = "";
    inWord = false;
    opaque = false;
  };
  const endCommand = () => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };
  for (let at = 0; at < script.length; at++) {
    const char = script[at] ?? "";
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else {
        if (char === "$" || char === "`") opaque = true;
        if (char === "\\" && quote === '"' && at + 1 < script.length)
          text += script[++at] ?? "";
        else text += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      if (at + 1 < script.length) {
        text += script[++at] ?? "";
        inWord = true;
      }
    } else if (char === " " || char === "\t") endWord();
    else if (char === "<" || char === ">") endWord();
    else if (";&|\n\r()`".includes(char)) {
      if (char === "`" || (char === "(" && text.endsWith("$"))) opaque = true;
      endCommand();
    } else {
      if (char === "$" || (char === "~" && !inWord)) opaque = true;
      text += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
};

/** The Bun subcommands that never run tests (`NEVER_RUNS_TESTS`). */
const BUN_NEVER = new Set(["build", "install", "add", "remove", "run"]);

/**
 * The program a command runs once its launchers and reserved words are taken off, and where its
 * own arguments start. `bun <name>` with a name that is not a file is that program (`bun --bun
 * vite build` is `vite`); `bun <file>` and an opaque word are programs the reader does not know.
 */
const programOf = (
  words: ReadonlyArray<ScriptWord>,
): { readonly program: string; readonly from: number } | undefined => {
  let at = 0;
  for (;;) {
    while (words[at]?.assignment === true) at++;
    const word = words[at];
    if (word === undefined) return undefined;
    if (word.opaque) return { program: "", from: at };
    const text = word.text;
    if (RESERVED_WORDS.has(text)) {
      at++;
      continue;
    }
    if (LAUNCHERS.has(text)) {
      at++;
      while (words[at]?.text.startsWith("-") === true) at++;
      continue;
    }
    if (
      (text === "pnpm" || text === "yarn") &&
      (words[at + 1]?.text === "exec" || words[at + 1]?.text === "dlx")
    ) {
      at += 2;
      continue;
    }
    if (text === "bun") {
      at++;
      while (
        words[at]?.opaque === false &&
        words[at]?.text.startsWith("-") === true
      )
        at += BUN_VALUE_FLAGS.has(words[at]?.text ?? "") ? 2 : 1;
      const next = words[at];
      if (next === undefined) return { program: "bun", from: at };
      if (next.opaque) return { program: "", from: at };
      if (next.text === "x") {
        at++;
        continue;
      }
      if (next.text === "test") return { program: "bun test", from: at + 1 };
      if (BUN_NEVER.has(next.text))
        return { program: `bun ${next.text}`, from: at + 1 };
      // A path is a file Bun runs; any other word is a package's binary, the program itself.
      if (next.text.includes("/") || /\.[cm]?[jt]sx?$/.test(next.text))
        return { program: "bun <file>", from: at };
      return { program: next.text, from: at + 1 };
    }
    if (text === "go") {
      at++;
      while (words[at]?.text.startsWith("-") === true)
        at += words[at]?.text === "-C" ? 2 : 1;
      const next = words[at];
      return next === undefined || next.opaque
        ? { program: "go", from: at }
        : { program: `go ${next.text}`, from: at + 1 };
    }
    return { program: text, from: at + 1 };
  }
};

/** Bun's flags whose value is the next word when written without `=`. */
const BUN_VALUE_FLAGS = new Set([
  "--cwd",
  "--filter",
  "-F",
  "--elide-lines",
  "--shell",
  "--env-file",
  "-r",
  "--preload",
  "--require",
  "--import",
  "-c",
  "--config",
  "--tsconfig-override",
]);

/** Pinned runners by their command word, and interpreters that can run a test file directly. */
const RUNNER_WORDS = new Set([
  "jest",
  "mocha",
  "vitest",
  "ava",
  "tap",
  "pytest",
]);
const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "bun",
  "deno",
  "playwright",
]);

/** The command word once assignments, reserved words and launchers are taken off. */
const headOf = (words: ReadonlyArray<ScriptWord>): number => {
  let at = 0;
  for (;;) {
    while (words[at]?.assignment === true) at++;
    const word = words[at];
    if (word === undefined || word.opaque) return at;
    if (RESERVED_WORDS.has(word.text)) at++;
    else if (LAUNCHERS.has(word.text)) {
      at++;
      while (words[at]?.text.startsWith("-") === true) at++;
    } else if (
      (word.text === "pnpm" || word.text === "yarn") &&
      (words[at + 1]?.text === "exec" || words[at + 1]?.text === "dlx")
    )
      at += 2;
    else return at;
  }
};

/** The most distinct directories a script's `cd` and `pushd` words are followed to. */
const CD_DIRECTORIES = 16;

/** The most glob tests (a pattern against a tree path) one call makes. */
const GLOB_TESTS = 5_000_000;

/** What a manifest's scripts name, by path: files, directories, and the package-wide cases. */
interface ScriptPathsRead {
  readonly files: ReadonlyArray<{ readonly path: string; readonly by: string }>;
  readonly directories: ReadonlyArray<{
    readonly path: string;
    readonly by: string;
  }>;
  readonly packageWide: ReadonlyArray<string>;
}

/**
 * Every path a manifest's scripts name, whether or not the reader follows the script, the command
 * or the runner (`looseCommands`): in each command that is not on `NEVER_RUNS_TESTS`, each word
 * after the program, with a `--flag=` or `NAME=` prefix and a pytest `::` node suffix taken off,
 * resolved against the manifest's directory and every literal directory a `cd` or `pushd` in the
 * script moved to. A file the tree confirms is named; a directory names every path under it; a
 * glob (`*`, `?`, `[`, `{`) names every tree path it matches. A `cd` to an opaque word, an opaque
 * word in a command other than `bun test` and the pinned runners (which have their own rules), and
 * a glob past the call's budget reach the whole package.
 */
const scriptPathsOf = (
  manifestPath: string,
  scripts: ReadonlyArray<{ readonly name: string; readonly text: string }>,
  tree: TreePaths,
  blobPaths: ReadonlyArray<string>,
  budget: { globTests: number },
): ScriptPathsRead => {
  const directory = directoryOf(manifestPath);
  const files: Array<{ path: string; by: string }> = [];
  const directories: Array<{ path: string; by: string }> = [];
  const packageWide: Array<string> = [];
  for (const { name, text } of scripts) {
    const by = `script-paths: ${manifestPath} script "${name}" names this path`;
    // The directories later words resolve against: the manifest's and each literal `cd` target,
    // each once, at most `CD_DIRECTORIES` of them (past that, the package is undecided).
    const bases = [directory];
    let capped = false;
    // Where the script is now (every `cd`, `pushd` and `popd` moves it, a revisited directory
    // included), apart from the distinct `bases` the cap counts.
    let cursor = directory;
    const pushed: Array<string> = [];
    /** Follows a literal directory word, at most `CD_DIRECTORIES` distinct bases. */
    const moveTo = (target: ScriptWord | undefined) => {
      if (target === undefined || target.opaque) {
        packageWide.push(
          `script-paths: ${manifestPath} script "${name}" changes directory to a place the reader cannot tell, so any file in the package may be one it names`,
        );
        return;
      }
      const moved = resolveIn(cursor, target.text);
      if (moved === undefined) return;
      cursor = moved;
      if (bases.includes(moved)) return;
      if (bases.length < CD_DIRECTORIES) bases.push(moved);
      else if (!capped) {
        capped = true;
        packageWide.push(
          `script-paths: ${manifestPath} script "${name}" changes directory to more than ${CD_DIRECTORIES} places, so any file in the package may be one it names`,
        );
      }
    };
    // `bun test` and the pinned runners read their own opaque words only where the reader
    // follows them: in a followed script, before any change of directory.
    let followed = followedCommands(text).unfollowed === undefined;
    for (const words of looseCommands(text)) {
      const found = programOf(words);
      if (found === undefined) continue;
      const { program, from } = found;
      if (program === "cd" || program === "pushd") {
        if (program === "pushd") pushed.push(cursor);
        moveTo(words[from]);
        followed = false;
        continue;
      }
      // Bun's `--cwd` anywhere in a `bun` command moves the run, as a `cd` does.
      if (words.some((word) => !word.opaque && word.text === "bun"))
        for (let at = 0; at < words.length; at++) {
          const word = words[at];
          if (word === undefined) continue;
          if (word.text === "--cwd") moveTo(words[at + 1]);
          else if (word.text.startsWith("--cwd="))
            moveTo(
              word.opaque
                ? word
                : { ...word, text: word.text.slice("--cwd=".length) },
            );
        }
      // The closing rule: where the reader does not follow the script, a pinned runner, or an
      // interpreter given a word the reader cannot resolve to a path, may run any file of the
      // package. Its flags are not read there.
      const head = words[headOf(words)];
      if (!followed && head !== undefined && !head.opaque) {
        if (RUNNER_WORDS.has(head.text))
          packageWide.push(
            `script-paths: ${manifestPath} script "${name}" runs ${head.text} where the reader does not follow the script, so any file in the package may be one of its tests`,
          );
        else if (
          INTERPRETERS.has(head.text) &&
          words.slice(headOf(words) + 1).some(
            (word) =>
              word.opaque ||
              !bases.some((base) => {
                const path = resolveIn(base, word.text);
                const kind = path === undefined ? undefined : tree.kindOf(path);
                return kind === "file" || kind === "directory";
              }),
          )
        )
          packageWide.push(
            `script-paths: ${manifestPath} script "${name}" runs ${head.text} with a word the reader cannot resolve to a path, where it does not follow the script, so any file in the package may be one it runs`,
          );
      }
      if (program === "popd") {
        cursor = pushed.pop() ?? cursor;
        followed = false;
        continue;
      }
      // `bun run <script> <words>`: the script is read in its own manifest, and Bun appends the
      // words after its name to it, so they count. Its own flags come before the name.
      let first = from;
      if (program === "bun run") {
        let workspaces = false;
        while (
          words[first]?.opaque === false &&
          words[first]?.text.startsWith("-") === true &&
          words[first]?.text !== "--"
        ) {
          const flag = words[first]?.text.split("=")[0] ?? "";
          if (flag === "--filter" || flag === "-F" || flag === "--workspaces")
            workspaces = true;
          first += BUN_VALUE_FLAGS.has(words[first]?.text ?? "") ? 2 : 1;
        }
        first++;
        // Run in every workspace, the words passed on may name a path in any of them.
        if (workspaces && words.length > first)
          directories.push({
            path: directory,
            by: `script-paths: ${manifestPath} script "${name}" passes words to a script in every workspace, so any file under the package may be one it names`,
          });
      } else if (NEVER_PROGRAMS.has(program)) continue;
      // `bun test` and the pinned runners read their own words' opaque and unconfirmed cases.
      const ownRules =
        followed &&
        (program === "bun test" ||
          RUNNER_COMMANDS.some((command) => {
            const start = words.findIndex((_, index) =>
              command.words.every(
                (text, at) =>
                  words[index + at]?.opaque === false &&
                  words[index + at]?.text === text,
              ),
            );
            return (
              start >= 0 &&
              (command.needs === undefined ||
                words
                  .slice(start + command.words.length)
                  .some((word) => !word.opaque && word.text === command.needs))
            );
          }));
      for (const word of words.slice(first)) {
        if (word.opaque) {
          if (!ownRules)
            packageWide.push(
              program === ""
                ? `script-paths: ${manifestPath} script "${name}" runs a command word the shell would change, so any file in the package may be one it names`
                : `script-paths: ${manifestPath} script "${name}" passes ${program} a word the shell would change, so any file in the package may be one it names`,
            );
          continue;
        }
        const named = word.text
          .replace(/^(?:--?[A-Za-z][\w.-]*|[A-Za-z_]\w*)=/, "")
          .replace(/::.*$/, "");
        if (named === "") continue;
        if (/[*?[{]/.test(named)) {
          for (const base of bases) {
            const pattern = resolveIn(base, named);
            if (pattern === undefined || pattern === "") continue;
            budget.globTests -= blobPaths.length;
            if (budget.globTests < 0) {
              packageWide.push(
                `script-paths: ${manifestPath} script "${name}" names a pattern past the reader's budget, so any file in the package may be one it names`,
              );
              break;
            }
            let glob: InstanceType<typeof Bun.Glob>;
            try {
              glob = new Bun.Glob(pattern);
            } catch {
              packageWide.push(
                `script-paths: ${manifestPath} script "${name}" names a pattern the reader cannot match, so any file in the package may be one it names`,
              );
              break;
            }
            for (const path of blobPaths)
              if (glob.match(path)) files.push({ path, by });
          }
          continue;
        }
        for (const base of bases) {
          const path = resolveIn(base, named);
          if (path === undefined) continue;
          const kind = tree.kindOf(path);
          if (kind === "file") files.push({ path, by });
          else if (kind === "directory") directories.push({ path, by });
        }
      }
    }
  }
  return { files, directories, packageWide };
};

export interface Declarations {
  /** Suggestions per path; a path with none is `undeclared`. */
  readonly byPath: ReadonlyMap<string, ReadonlyArray<Suggestion>>;
  readonly readers: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  /**
   * The paths asked whose test status the reader could not settle, each with `by`: the declaration
   * it could not follow, or the convention of a runner it does not read. No path here has a `test`
   * suggestion. Always set by `readDeclarations`; optional so a caller's own empty value still
   * types, and `testStatusOf` requires it.
   */
  readonly undecided?: ReadonlyMap<string, string>;
}

/** What `readDeclarations` gives: `undecided` always set. */
export type ReadDeclarations = Declarations & {
  readonly undecided: ReadonlyMap<string, string>;
  /** The paths the declarations were read for; any other path is undecided. */
  readonly asked: ReadonlySet<string>;
};

/** The `by` of a path the declarations were not read for. */
export const NOT_ASKED_BY =
  "not among the paths the declarations were read for";

/**
 * Whether a path is a test: `test` when a declaration says so; else undecided, with `by`, when the
 * reader could not follow a declaration that covers it, it matches a runner's convention the
 * reader does not read, or it is not among the paths asked; else `not-test`, by declarations the
 * reader followed. A name only ever
 * withholds: it never makes a path a test, and never makes one `not-test`.
 */
export const testStatusOf = (
  declarations: Pick<ReadDeclarations, "byPath" | "undecided" | "asked">,
  path: string,
): "test" | "not-test" | { readonly undecided: string } => {
  if (
    declarations.byPath.get(path)?.some((entry) => entry.kind === "test") ===
    true
  )
    return "test";
  // A path the reader was not asked about was never looked at.
  if (!declarations.asked.has(path)) return { undecided: NOT_ASKED_BY };
  const by = declarations.undecided.get(path);
  return by === undefined ? "not-test" : { undecided: by };
};

/**
 * The declarations at one revision for the given paths. `tree` is the revision's tree listing, for
 * the package manifests, the `bunfig.toml` beside each and the paths a script names; `contents` is
 * any blob text already read, for the generated marker.
 */
export const readDeclarations = (options: {
  readonly repository: string;
  readonly revision: string;
  readonly tree: ReadonlyArray<TreeEntry>;
  readonly paths: ReadonlyArray<string>;
  readonly contents?: ReadonlyMap<string, Uint8Array>;
  /** The script words read per call before the remaining manifests are not read (200,000). */
  readonly wordBudget?: number;
  /**
   * `false` skips the generated-marker reader: no file's first bytes are read for it, and no
   * marker suggestion or gap is given. Absent, the marker is read.
   */
  readonly markers?: false;
  /** Run the `linguist` reader; off unless given (only the range manifest asks). */
  readonly linguist?: boolean;
  /**
   * The revision whose attributes the `linguist` reader reads, where it is not `revision`: the
   * range manifest reads a deleted file at the base and its attributes at the head, as the
   * `generated` rule does.
   */
  readonly linguistAttributesAt?: string;
  /**
   * The paths the `linguist` reader asks, where not all of `paths`: the range manifest's base call
   * asks only for files deleted outright, so a path the head side has (a type change, deleted and
   * added on one path) is decided by the head alone, as the `generated` rule reads its head blob.
   */
  readonly linguistPaths?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const byPath = new Map<string, Array<Suggestion>>();
    const withLinguist = options.linguist === true;
    const gaps = [...DECLARATION_GAPS, ...(withLinguist ? [LINGUIST_GAP] : [])];
    const add = (path: string, suggestion: Suggestion) => {
      const list = byPath.get(path) ?? [];
      if (!list.some((entry) => entry.by === suggestion.by))
        list.push(suggestion);
      byPath.set(path, list);
    };
    for (const [path, list] of yield* attributes(
      options.repository,
      options.revision,
      options.paths,
    ))
      for (const suggestion of list) add(path, suggestion);

    const blobAt = new Map(
      options.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, entry]),
    );
    // Configuration is a regular blob; a symbolic link's blob is its target text, never followed.
    const configs = (name: string) =>
      options.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.mode !== SYMLINK_MODE &&
          posix.basename(entry.path) === name,
      );
    const linked = (name: string) =>
      options.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.mode === SYMLINK_MODE &&
          posix.basename(entry.path) === name,
      );
    // Where the reader gave up, per manifest directory, in manifest and script order: a test-named
    // file there that no followed script declares a test is undecided, with the first `by`. A
    // place whose run may go anywhere (`repository`) also reaches every other test-named file.
    type Stop = { order: number; by: string };
    const stopsAt = new Map<string, Array<Stop>>();
    let stops = 0;
    let firstAnywhere: Stop | undefined;
    // Per package (a manifest's directory), the first place whose words may name any file there.
    const packageWideAt = new Map<string, string>();
    const stopAt = (manifestPath: string, by: string, scope: StopScope) => {
      const directory = directoryOf(manifestPath);
      const list = stopsAt.get(directory) ?? [];
      const stopped = { order: stops++, by };
      list.push(stopped);
      stopsAt.set(directory, list);
      if (scope === "repository" && firstAnywhere === undefined)
        firstAnywhere = stopped;
      if (scope === "package" && !packageWideAt.has(directory))
        packageWideAt.set(directory, by);
    };
    // The files a followed script gives another runner (`RUNNER_COMMANDS`): a file, or every file
    // under a directory, the first in manifest and script order; and the directories a followed
    // script names as Bun's test roots.
    const commandFileAt = new Map<string, string>();
    const commandDirectoryAt = new Map<string, string>();
    // The paths any script names (`scriptPathsOf`), whether the reader follows it or not.
    const scriptFileAt = new Map<string, string>();
    const scriptDirectoryAt = new Map<string, string>();
    // Per package, the first script word that may name any file there (after the places above).
    const scriptWideAt = new Map<string, string>();
    const blobPaths = options.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    const globBudget = { globTests: GLOB_TESTS };
    const namedRootAt = new Map<string, string>();
    // A manifest whose scripts were not read may run anything: every path of its package is
    // undecided (the same scope as an opaque word), and it names test-named files anywhere.
    const unreadAt = (manifestPath: string, by: string) => {
      stopAt(manifestPath, by, "repository");
      if (!packageWideAt.has(directoryOf(manifestPath)))
        packageWideAt.set(directoryOf(manifestPath), by);
    };
    const allManifests = configs("package.json");
    for (const entry of allManifests)
      if ((entry.size ?? 0) > MANIFEST_BYTES)
        unreadAt(
          entry.path,
          `package-scripts-bun-test: ${entry.path} is over ${MANIFEST_BYTES / 1024} KiB, so its scripts were not read`,
        );
    for (const entry of linked("package.json"))
      unreadAt(
        entry.path,
        `package-scripts-bun-test: ${entry.path} is a symbolic link the reader does not follow, so its scripts were not read`,
      );
    const manifests = allManifests.filter(
      (entry) => (entry.size ?? 0) <= MANIFEST_BYTES,
    );
    // Only a `bunfig.toml` in a manifest's own directory can name its wrapper.
    const manifestDirectories = new Set(
      manifests.map((entry) => posix.dirname(entry.path)),
    );
    const besideManifests = configs("bunfig.toml").filter((entry) =>
      manifestDirectories.has(posix.dirname(entry.path)),
    );
    const bunfigs = besideManifests.filter(
      (entry) => (entry.size ?? 0) <= BUNFIG_BYTES,
    );
    // Runner configuration files the reader does not read (`RUNNER_CONFIGS`), any mode; the
    // pytest files that count only when they set `python_files` are read with the manifests.
    const runnerConfigs = options.tree.flatMap((entry) => {
      if (entry.type !== "blob") return [];
      const name = posix.basename(entry.path);
      const config = RUNNER_CONFIGS.find((each) => each.name.test(name));
      return config === undefined ? [] : [{ entry, config }];
    });
    const pythonConfigs = runnerConfigs.filter(
      ({ entry, config }) =>
        config.when === "python_files" &&
        entry.mode !== SYMLINK_MODE &&
        (entry.size ?? 0) <= PYTHON_CONFIG_BYTES,
    );
    const configBytes = yield* readBlobs(options.repository, [
      ...new Set(
        [
          ...manifests,
          ...bunfigs,
          ...pythonConfigs.map(({ entry }) => entry),
        ].map((entry) => entry.oid),
      ),
    ]);
    const tree = treePathsOf(options.tree, blobAt);
    const bunfigAt = new Map<string, BesideBunfig>();
    // A symbolic link named `bunfig.toml` is never read, but Bun follows it: its `[test]` table
    // may narrow what Bun runs, as an unreadable one may, and its preloads are not known.
    for (const entry of linked("bunfig.toml"))
      if (manifestDirectories.has(posix.dirname(entry.path)))
        bunfigAt.set(posix.dirname(entry.path), {
          path: entry.path,
          preloads: [],
          narrows: true,
          why: "is a symbolic link the reader does not follow",
          preloadsUnknown: "is a symbolic link the reader does not follow",
        });
    // Each blob is parsed once, however many directories hold it.
    const tableByOid = new Map<string, BunfigTestTable>();
    let missingBunfigs = 0;
    let oversizedBunfigs = 0;
    let invalidBunfigs = 0;
    for (const bunfig of besideManifests) {
      // A `bunfig.toml` whose `[test]` table the reader cannot see may narrow what Bun runs, so
      // the manifest beside it declares nothing.
      const unseen = (why: string) =>
        bunfigAt.set(posix.dirname(bunfig.path), {
          path: bunfig.path,
          preloads: [],
          narrows: true,
          why,
          preloadsUnknown: why,
        });
      const bytes = configBytes.get(bunfig.oid);
      if (
        (bunfig.size ?? 0) > BUNFIG_BYTES ||
        (bytes?.length ?? 0) > BUNFIG_BYTES
      ) {
        oversizedBunfigs++;
        unseen(BUNFIG_OVERSIZED);
        continue;
      }
      if (bytes === undefined) {
        missingBunfigs++;
        unseen("could not be read");
        continue;
      }
      let table = tableByOid.get(bunfig.oid);
      if (table === undefined) {
        table = bunfigTestTable(new TextDecoder().decode(bytes));
        tableByOid.set(bunfig.oid, table);
      }
      if (table.invalid) invalidBunfigs++;
      bunfigAt.set(posix.dirname(bunfig.path), {
        path: bunfig.path,
        preloads: resolvePreloads(bunfig.path, table.preloads),
        narrows: table.narrows,
        ...(table.why === undefined ? {} : { why: table.why }),
        ...(table.unseen === true && table.why !== undefined
          ? { preloadsUnknown: table.why }
          : {}),
      });
    }
    // Each root with the scripts that give it, in manifest and script order.
    type Given = { order: number; script: string; by: string };
    const rootsAt = new Map<string, Array<Given>>();
    let order = 0;
    let missingManifests = 0;
    // Script words are resolved per directory while a blob is stored once, so a call stops reading
    // manifests once their words pass the budget.
    const wordBudget = options.wordBudget ?? WORD_BUDGET;
    let words = 0;
    let unread = 0;
    // Each manifest blob is parsed and its scripts read once, however many directories hold it.
    const scriptsByOid = new Map<
      string,
      { read: ManifestRead; words: number }
    >();
    // What each manifest directory's `package.json` says about other runners: undefined where it
    // was not read, which may hold anything.
    const runnersAt = new Map<
      string,
      | Pick<
          ManifestRead,
          "runnerKeys" | "namesVitest" | "namesRunners" | "scriptTexts"
        >
      | undefined
    >();
    for (const entry of allManifests)
      if ((entry.size ?? 0) > MANIFEST_BYTES)
        runnersAt.set(directoryOf(entry.path), undefined);
    for (const entry of linked("package.json"))
      runnersAt.set(directoryOf(entry.path), undefined);
    for (const manifest of manifests) {
      const bytes = configBytes.get(manifest.oid);
      runnersAt.set(directoryOf(manifest.path), undefined);
      if (bytes === undefined) {
        missingManifests++;
        unreadAt(
          manifest.path,
          `package-scripts-bun-test: ${manifest.path} could not be read, so its scripts were not read`,
        );
        continue;
      }
      const overBudget = `package-scripts-bun-test: ${manifest.path} was not read: the budget of ${wordBudget} script words per call was spent`;
      if (unread > 0) {
        unread++;
        unreadAt(manifest.path, overBudget);
        // Its scripts were not read: any of them may name any file in its package.
        if (!packageWideAt.has(directoryOf(manifest.path)))
          packageWideAt.set(directoryOf(manifest.path), overBudget);
        continue;
      }
      let cached = scriptsByOid.get(manifest.oid);
      if (cached === undefined) {
        const read = manifestScripts(new TextDecoder().decode(bytes));
        cached = { read, words: wordsIn(read) };
        scriptsByOid.set(manifest.oid, cached);
      }
      runnersAt.set(directoryOf(manifest.path), cached.read);
      if (words + cached.words > wordBudget) {
        unread++;
        unreadAt(manifest.path, overBudget);
        // Its scripts were not read: any of them may name any file in its package.
        if (!packageWideAt.has(directoryOf(manifest.path)))
          packageWideAt.set(directoryOf(manifest.path), overBudget);
        continue;
      }
      words += cached.words;
      const named = scriptPathsOf(
        manifest.path,
        cached.read.scriptTexts,
        tree,
        blobPaths,
        globBudget,
      );
      for (const { path, by } of named.files)
        if (!scriptFileAt.has(path)) scriptFileAt.set(path, by);
      for (const { path, by } of named.directories)
        if (!scriptDirectoryAt.has(path)) scriptDirectoryAt.set(path, by);
      for (const by of named.packageWide)
        if (!scriptWideAt.has(directoryOf(manifest.path)))
          scriptWideAt.set(directoryOf(manifest.path), by);
      if ("unread" in cached.read) {
        const by = `package-scripts-bun-test: ${manifest.path} ${cached.read.unread}, so its scripts were not read`;
        // A manifest that is not JSON was not read at all; one whose scripts are not all strings
        // had its string scripts read above.
        if (cached.read.unread === "is not valid JSON")
          unreadAt(manifest.path, by);
        else stopAt(manifest.path, by, "repository");
        continue;
      }
      const bunfig = bunfigAt.get(posix.dirname(manifest.path));
      const given = scriptRoots(
        manifest.path,
        cached.read.scripts,
        bunfig === undefined ? { tree } : { tree, bunfig },
      );
      for (const { script, unfollowed, scope } of given.unfollowed)
        stopAt(
          manifest.path,
          `package-scripts-bun-test: ${manifest.path} script "${script}" ${unfollowed}`,
          scope,
        );
      for (const { root, script } of given.namedRoots)
        if (!namedRootAt.has(root) && tree.kindOf(root) === "directory")
          namedRootAt.set(
            root,
            `package-scripts-bun-test: under the test root ${root === "" ? "(the repository's root)" : root} of ${manifest.path} script "${script}"; not itself a test file`,
          );
      const commands = runnerCommandsOf(
        manifest.path,
        cached.read.scripts,
        tree,
      );
      for (const { path, by } of commands.named) {
        const at =
          tree.kindOf(path) === "file" ? commandFileAt : commandDirectoryAt;
        if (!at.has(path)) at.set(path, by);
      }
      const own = directoryOf(manifest.path);
      for (const by of commands.packageWide)
        if (!packageWideAt.has(own)) packageWideAt.set(own, by);
      for (const { root, script, wrapper } of given.roots) {
        const by =
          wrapper === undefined
            ? `package-scripts-bun-test: ${manifest.path} script "${script}"`
            : `package-scripts-bun-test: ${manifest.path} script "${script}" runs ${wrapper.path}, which ${wrapper.bunfig} names in [test].preload`;
        const list = rootsAt.get(root) ?? [];
        list.push({
          order: order++,
          script: JSON.stringify([manifest.path, script]),
          by,
        });
        rootsAt.set(root, list);
      }
    }
    if (unread > 0)
      gaps.push(
        `package-scripts-bun-test: ${unread} package manifest(s) were not read: the budget of ${wordBudget} script words per call was spent; their test roots were not checked`,
      );
    if (missingManifests > 0)
      gaps.push(
        `package-scripts-bun-test: ${missingManifests} package manifest(s) could not be read; their test roots were not checked`,
      );
    if (missingBunfigs > 0)
      gaps.push(
        `package-scripts-bun-test: ${missingBunfigs} bunfig.toml file(s) could not be read; the test wrappers they name were not checked`,
      );
    if (oversizedBunfigs > 0)
      gaps.push(
        `package-scripts-bun-test: ${oversizedBunfigs} bunfig.toml file(s) over ${BUNFIG_BYTES / 1024} KiB were not read; the test wrappers they name were not checked`,
      );
    if (invalidBunfigs > 0)
      gaps.push(
        `package-scripts-bun-test: ${invalidBunfigs} bunfig.toml file(s) are not valid TOML; the test roots of the manifests beside them were not checked`,
      );
    // The test-named paths asked, sorted once; each root takes the block of paths at or under it.
    const testPaths =
      order === 0
        ? []
        : [
            ...new Set(
              options.paths.filter((path) =>
                BUN_TEST_FILE.test(posix.basename(path)),
              ),
            ),
          ].sort(byCodeUnits);
    // Per path, one entry per script: whichever of its roots or forms comes first in order.
    const found = new Map<string, Map<string, Given>>();
    const give = (path: string | undefined, list: ReadonlyArray<Given>) => {
      if (path === undefined) return;
      const held = found.get(path) ?? new Map<string, Given>();
      for (const given of list) {
        const kept = held.get(given.script);
        if (kept === undefined || given.order < kept.order)
          held.set(given.script, given);
      }
      found.set(path, held);
    };
    const asked = new Set(options.paths);
    for (const [root, list] of rootsAt) {
      // A file the script names is run whatever its name (`bun test ./scripts/check.ts`).
      if (asked.has(root) && tree.kindOf(root) === "file") give(root, list);
      const below = root === "" ? "" : `${root}/`;
      for (
        let at = lowerBound(testPaths, below);
        testPaths[at]?.startsWith(below) === true;
        at++
      ) {
        const path = testPaths[at] ?? "";
        // Bun's discovery skips hidden directories and `node_modules` below the root it searches.
        if (!skippedBelow(path.slice(below.length))) give(path, list);
      }
    }
    for (const path of options.paths) {
      const held = found.get(path);
      if (held === undefined) continue;
      for (const { by } of [...held.values()].sort((a, b) => a.order - b.order))
        add(path, { kind: "test", by: `${by}, Bun's test-file rule` });
    }
    // The runner configuration the reader does not read, per directory it configures, the first
    // in tree order: a runner key in a manifest, a manifest that was not read (it may hold one),
    // and each `RUNNER_CONFIGS` file.
    const configAt = new Map<string, string>();
    const configures = (directory: string, by: string) => {
      if (!configAt.has(directory)) configAt.set(directory, by);
    };
    for (const [directory, runners] of runnersAt) {
      const manifest =
        directory === "" ? "package.json" : `${directory}/package.json`;
      if (runners === undefined)
        configures(
          directory,
          `runner-configs: ${manifest} was not read, so the jest, ava or mocha configuration it may hold is not known`,
        );
      else
        for (const key of runners.runnerKeys)
          configures(
            directory,
            `runner-configs: ${manifest} holds a "${key}" key, runner configuration the reader does not read`,
          );
    }
    for (const { entry, config } of runnerConfigs) {
      let directory = directoryOf(entry.path);
      // Karma also looks in a `.config` directory, for the project above it.
      if (posix.basename(directory) === ".config")
        directory = directoryOf(directory);
      if (config.when === "vitest") {
        // Vite alone runs no tests; only where the package names Vitest (or was not read).
        if (!runnersAt.has(directory)) continue;
        if (runnersAt.get(directory)?.namesVitest === false) continue;
      }
      if (config.when === "python_files") {
        const bytes =
          entry.mode === SYMLINK_MODE || (entry.size ?? 0) > PYTHON_CONFIG_BYTES
            ? undefined
            : configBytes.get(entry.oid);
        // Read: it counts when it sets `python_files` anywhere (wider than its pytest section).
        if (
          bytes !== undefined &&
          !new TextDecoder().decode(bytes).includes("python_files")
        )
          continue;
      }
      configures(
        directory,
        `runner-configs: ${entry.path} (${config.runner}'s ${config.names}), runner configuration the reader does not read`,
      );
    }
    // The first place the reader gave up, per manifest directory.
    const firstStopAt = new Map<string, Stop>();
    for (const [directory, list] of stopsAt) {
      const first = list[0];
      if (first !== undefined) firstStopAt.set(directory, first);
    }
    // The package a path is in: the nearest directory above it with a `package.json`, so a nested
    // package's files are its own, not the outer one's.
    const packageDirectories = new Set([
      ...allManifests.map((entry) => directoryOf(entry.path)),
      ...linked("package.json").map((entry) => directoryOf(entry.path)),
    ]);
    // Every package at or above a path, nearest first.
    const packagesOf = (path: string): ReadonlyArray<string> => {
      const found: Array<string> = [];
      for (
        let directory = directoryOf(path);
        ;
        directory = directoryOf(directory)
      ) {
        if (packageDirectories.has(directory)) found.push(directory);
        if (directory === "") return found;
      }
    };
    const packageOf = (path: string): string | undefined => {
      for (
        let directory = directoryOf(path);
        ;
        directory = directoryOf(directory)
      ) {
        if (packageDirectories.has(directory)) return directory;
        if (directory === "") return undefined;
      }
    };
    // A file is not a test only when nothing could make it one. Every file named like a test that
    // no followed script declares a test is undecided: one named like a Bun test with the nearest
    // place the reader gave up (its own package's first, else the first whose run may go
    // anywhere), else Bun's rule; any other with the convention or test folder it matches. Then
    // every other file another runner is given, or under a test root a followed script names (a
    // package's directory by default is not named), or under a directory another runner is given,
    // or under a runner configuration the reader does not read, or in a package where a script's
    // words may name any file. Bun's skip of hidden directories and `node_modules` is not applied.
    const undecided = new Map<string, string>();
    for (const path of options.paths) {
      if (undecided.has(path) || found.has(path)) continue;
      const pkg = packageOf(path);
      const by = BUN_TEST_FILE.test(posix.basename(path))
        ? ((nearestAt(firstStopAt, path) ?? firstAnywhere)?.by ?? BUN_NAMED_BY)
        : (conventionOf(path) ??
          testFolderOf(path) ??
          gatedConventionOf(path, packagesOf(path), runnersAt) ??
          commandFileAt.get(path) ??
          scriptFileAt.get(path) ??
          nearestAt(namedRootAt, path) ??
          nearestAt(commandDirectoryAt, path) ??
          nearestAt(scriptDirectoryAt, path) ??
          nearestAt(configAt, path) ??
          (pkg === undefined
            ? undefined
            : (packageWideAt.get(pkg) ?? scriptWideAt.get(pkg))));
      if (by !== undefined) undecided.set(path, by);
    }

    let missingMarkers = 0;
    for (
      let at = 0;
      options.markers !== false && at < options.paths.length;
      at += MARKER_GROUP_PATHS
    ) {
      const paths = options.paths.slice(at, at + MARKER_GROUP_PATHS);
      const unread = paths.filter(
        (path) => options.contents?.get(path) === undefined && blobAt.has(path),
      );
      const read = yield* readBlobs(
        options.repository,
        unread.map((path) => blobAt.get(path)?.oid ?? ""),
        { headBytes: MARKER_BYTES },
      );
      for (const path of paths) {
        const bytes =
          options.contents?.get(path) ?? read.get(blobAt.get(path)?.oid ?? "");
        if (bytes === undefined) {
          if (blobAt.has(path)) missingMarkers++;
          continue;
        }
        const head = new TextDecoder().decode(bytes.subarray(0, MARKER_BYTES));
        const marker = GENERATED_MARKER.exec(head)?.[0];
        if (marker !== undefined)
          add(path, {
            kind: "generated",
            by: `generated-marker: "${marker}" in its first ${MARKER_BYTES} bytes`,
          });
      }
    }
    if (missingMarkers > 0)
      gaps.push(
        `generated-marker: ${missingMarkers} blob(s) could not be read; their generated markers were not checked`,
      );
    if (withLinguist) {
      const marked = yield* linguist(
        options.repository,
        options.linguistAttributesAt ?? options.revision,
        options.tree,
        options.linguistPaths ?? options.paths,
      );
      for (const [path, list] of marked.found)
        for (const suggestion of list) add(path, suggestion);
      gaps.push(...marked.gaps);
    }
    const declarations: ReadDeclarations = {
      byPath,
      readers: DECLARATION_READERS.filter(
        (reader) => withLinguist || reader !== "linguist",
      ),
      gaps,
      undecided,
      asked,
    };
    return declarations;
  });

/** The declared kinds of a path, or `undeclared`. */
export const kindsOf = (
  declarations: Pick<Declarations, "byPath">,
  path: string,
): ReadonlyArray<DeclaredKind> | "undeclared" => {
  const list = declarations.byPath.get(path);
  if (list === undefined || list.length === 0) return "undeclared";
  return [...new Set(list.map((entry) => entry.kind))].sort();
};
