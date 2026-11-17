import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { z } from "zod";
import {
  git,
  gitMeasured,
  gitWithInput,
  resolveCommit,
  type GitFailed,
} from "./git.ts";
import { groupsBySize, readBlobs } from "./git-objects.ts";
import {
  LINGUIST_STANDARD,
  linguistMark,
  type LinguistMark,
} from "./linguist/index.ts";

/**
 * Where GitHub Linguist's two lists, generated and vendored, stand for a file with the repository's
 * own word on them (decision 14.18): the one decision the `generated` rule (`section-rules.ts`) and
 * the declarations' `linguist` reader (`declarations.ts`) both make, so the map's exclusion and the
 * rule's judgement never disagree on whether a file is marked. It holds the attribute values as
 * `git check-attr` prints them and how Linguist reads them, the isolated read of a revision's
 * attributes and what makes it unsure, which blobs Linguist's rules read and up to what size, and
 * the per-list state. Both modules import it; neither imports the other.
 *
 * Nothing here decides a lane or approves anything. A mark is the standard's finding with the
 * repository's attributes applied.
 */

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The largest blob read: the index's size bound (`INDEX_BOUNDS.maxFileBytes` in `search-index.ts`),
 * for a `.gitattributes` file and for a blob Linguist's rules read. Held equal to it by a test, not
 * imported: `search-index.ts` imports `declarations.ts`, which imports this module. A blob over it
 * is not read: Linguist's path rules still mark it, its content rules give no mark.
 */
export const READ_BOUND_BYTES = 1_048_576;

/** A `.gitattributes` value as `git check-attr` prints it: set, unset, unspecified, or a string. */
export const AttributeValue = z.strictObject({
  state: z.enum(["set", "unset", "unspecified", "value"]),
  /** The literal string, only when `state` is `value`. */
  value: z.string().nullable(),
});
export type AttributeValue = z.infer<typeof AttributeValue>;

export type AttributeName = "linguist-generated" | "linguist-vendored";
/** The attributes the isolated read asks for: the two lists', and `diff` for `-diff`. */
export type ReadAttributeName = AttributeName | "diff";

/**
 * An attribute of a path whose printed word (`unset` or `unspecified`) could be a state or a value
 * spelled like it: `files` are the revision's `.gitattributes` over the path that hold the literal
 * `<attribute>=<word>`, `unread` those over it whose blob was not read (over the size bound, or not
 * returned), so whether they hold it is not known.
 */
export interface AmbiguousAttribute {
  readonly attribute: ReadAttributeName;
  readonly word: "unset" | "unspecified";
  readonly files: ReadonlyArray<string>;
  readonly unread: ReadonlyArray<string>;
}

/** What makes the attribute read unsure for a path. */
export interface AttributeTrust {
  readonly ambiguous: ReadonlyArray<AmbiguousAttribute>;
}

/**
 * Whether a path can be given to `linguistMark`. Git's paths reach the harness decoded lossily:
 * `diffTrees` unquotes them through a non-fatal `TextDecoder` and `git` reads output through
 * `Response.text()`, so a path that is not valid UTF-8 holds U+FFFD, and a rule could match the
 * replaced path where Ruby would raise. Such a path is not marked, nor one holding a NUL or a lone
 * surrogate, on which `linguistMark` throws as Ruby does. A path that truly holds U+FFFD is refused
 * with them: it cannot be told apart.
 */
export const markablePath = (path: string) =>
  !/[\uFFFD\0]|[\uD800-\uDFFF]/u.test(path);

/** The path's Linguist mark, or null where the path is not markable. */
export const linguistMarkOf = (path: string, contents?: Uint8Array) =>
  markablePath(path) ? linguistMark(path, contents) : null;

// As Linguist reads an attribute that is not nil: `attribute != "false" && attribute != false`.
export const isSet = (value: AttributeValue) =>
  value.state === "set" || (value.state === "value" && value.value !== "false");
export const isUnset = (value: AttributeValue) =>
  value.state === "unset" ||
  (value.state === "value" && value.value === "false");
export const attributeText = (value: AttributeValue) =>
  value.state === "value" ? (value.value ?? "") : value.state;

export type ListName = "generated" | "vendored";

/**
 * Well-known control files (the owner's ruling of 13 November 2026, amending 14.18): Linguist's
 * lists never exclude these, whatever rule or pattern marks them. Only files whose place a tool's
 * own documented convention fixes for every repository are listed: never a path particular to
 * one repository, and never a rule that guesses from a folder name (`extern`, `third-party/`,
 * fixtures, dotfiles in general, `.d.ts`), which stay excluded as the lists mark them. The
 * repository's own attributes still decide in both directions: `linguist-vendored` or
 * `linguist-generated` set marks a control file, since that is the repository's declaration and not
 * the lists. Trimmed to what the pinned lists can reach: Linguist's `vendor.yml` names these, and
 * its generated rules can mark a workflow (`vcr_cassette?` on a `.yml`) or a TeamCity file (a
 * content rule on an `.xml`, or any rule on a file under `.teamcity/`).
 */
export const CONTROL_FILES = Object.freeze([
  {
    id: "github-actions-workflow",
    pattern: String.raw`^\.github/workflows/[^/]+\.ya?ml$`,
    convention:
      "workflow files live in the repository's .github/workflows directory, as .yml or .yaml",
    documentation: "GitHub Actions: workflow syntax",
  },
  {
    id: "jenkins-pipeline",
    pattern: String.raw`^Jenkinsfile$`,
    convention:
      "a Jenkinsfile at the root of the repository, the default script path",
    documentation: "Jenkins: Pipeline, using a Jenkinsfile",
  },
  {
    id: "teamcity-versioned-settings",
    pattern: String.raw`^\.teamcity/`,
    convention:
      "versioned settings, Kotlin DSL or XML, are stored in the .teamcity directory at the repository root",
    documentation: "TeamCity: storing project settings in version control",
  },
  {
    id: "git-submodules",
    pattern: String.raw`^\.gitmodules$`,
    convention: "the .gitmodules file at the top level of the working tree",
    documentation: "Git: gitmodules(5)",
  },
  {
    id: "git-ignore",
    pattern: String.raw`(^|/)\.gitignore$`,
    convention: "a .gitignore in any directory applies to that directory",
    documentation: "Git: gitignore(5)",
  },
  {
    id: "git-attributes",
    pattern: String.raw`(^|/)\.gitattributes$`,
    convention: "a .gitattributes in any directory applies to that directory",
    documentation: "Git: gitattributes(5)",
  },
] as const);
export type ControlFileId = (typeof CONTROL_FILES)[number]["id"];

/** Changes whenever the list changes: the SHA-256 of its canonical JSON. */
export const CONTROL_FILES_RECIPE = `neuve-control-files:sha256:${createHash("sha256").update(JSON.stringify(CONTROL_FILES)).digest("hex")}`;

const CONTROL_FILE_REGEXPS = CONTROL_FILES.map((entry) => ({
  entry,
  regexp: new RegExp(entry.pattern, "u"),
}));

/** The control-file entry a repository path matches, or undefined. */
export const controlFileOf = (path: string) =>
  CONTROL_FILE_REGEXPS.find(({ regexp }) => regexp.test(path))?.entry;

/** What a kept file's record says. */
export const keptBy = (id: string) => `kept: control file (${id})`;

/**
 * Where one of Linguist's two lists stands for a file, with the repository's word on it: on by a
 * declaration, on by the standard, kept (the standard marks a well-known control file, which the
 * lists never exclude), turned off by the repository's attribute, not known, or silent.
 */
export type ListState =
  | { readonly state: "declared"; readonly readers: ReadonlyArray<string> }
  | { readonly state: "standard"; readonly match: string }
  | {
      readonly state: "kept";
      readonly match: string;
      readonly entry: ControlFileId;
    }
  | {
      readonly state: "turned-off";
      readonly by: string;
      readonly over: ReadonlyArray<string>;
    }
  | { readonly state: "unknown" }
  | { readonly state: "silent" };

/** The repository's attribute as a declared reader names it, e.g. `gitattributes: linguist-vendored=set`. */
export const attributeReader = (list: ListName, value: AttributeValue) =>
  `gitattributes: linguist-${list}=${attributeText(value)}`;

/** What the lists read of one path: its two attributes and its Linguist mark. */
export interface ListSignals {
  readonly attributes: {
    readonly "linguist-generated": AttributeValue;
    readonly "linguist-vendored": AttributeValue;
  };
  /** Null where the path is not one Linguist can be asked about (`markablePath`). */
  readonly mark: LinguistMark | null;
}

/**
 * Each list's state for a file. The generated list is a declared reader (`generatedReaders`: a
 * generated header, `-diff`; the `linguist` reader passes none), `linguist-generated` set, or a
 * Linguist generated rule; the vendored list is `linguist-vendored` set, or a vendor pattern. The
 * repository's word wins per list in both directions: its attribute set marks the file whatever the
 * standard says; unset or false turns that list's marks off. A list is `unknown` where the standard
 * could not answer (the path is not markable, or a generated rule that could fire was not
 * evaluated) and nothing else marks it. A list the standard alone marks is `kept` where `path` is a
 * well-known control file (`CONTROL_FILES`): the repository's attribute and declared readers are
 * weighed first, as for any file. Trust in the attribute read is the caller's to weigh first.
 */
export const listStatesOf = (
  signals: ListSignals,
  generatedReaders: ReadonlyArray<string>,
  path: string,
) => {
  const control = controlFileOf(path);
  const attributes = {
    generated: signals.attributes["linguist-generated"],
    vendored: signals.attributes["linguist-vendored"],
  };
  const mark = signals.mark;
  const rule = mark?.generated?.rule ?? null;
  const pattern = mark?.vendored?.pattern ?? null;
  const unanswered = rule === null && (mark?.notEvaluated.length ?? 0) > 0;
  const stateOf = (
    list: ListName,
    readers: ReadonlyArray<string>,
    match: string | null,
    open: boolean,
  ): ListState => {
    const value = attributes[list];
    if (isSet(value))
      return {
        state: "declared",
        readers: [...new Set([...readers, attributeReader(list, value)])].sort(
          byCodeUnits,
        ),
      };
    const marks = [...readers, ...(match === null ? [] : [match])];
    if (isUnset(value))
      return {
        state: "turned-off",
        by: attributeReader(list, value),
        over: marks,
      };
    if (readers.length > 0) return { state: "declared", readers };
    if (match !== null)
      return control === undefined
        ? { state: "standard", match }
        : { state: "kept", match, entry: control.id };
    return open ? { state: "unknown" } : { state: "silent" };
  };
  const lists: Record<ListName, ListState> = {
    generated: stateOf(
      "generated",
      [...new Set(generatedReaders)].sort(byCodeUnits),
      rule,
      mark === null || unanswered,
    ),
    vendored: stateOf("vendored", [], pattern, mark === null),
  };
  return { attributes, mark, rule, pattern, unanswered, lists, control };
};

/** The two lists as the map's exclusion names them. */
export type LinguistStandard = "linguist-generated" | "linguist-vendored";

/** One list that marks a file, and what fired: the rule, the pattern or the repository's attribute. */
export interface LinguistListMark {
  readonly standard: LinguistStandard;
  readonly by: string;
}

/** A well-known control file the lists marked and did not exclude, with what marked it. */
export interface LinguistKept {
  readonly entry: ControlFileId;
  readonly by: string;
  readonly lists: ReadonlyArray<{
    readonly standard: LinguistStandard;
    readonly match: string;
  }>;
}

/**
 * The lists that mark a file by the standard and the repository's attributes alone, in list order:
 * the `generated` rule's holding judgement with no other declared reader. None where the attribute
 * read is unsure (`trust`), as the rule refuses such a file; none for a list that is turned off,
 * silent, unknown (the safe direction: the file is read) or kept. `by` names Linguist's version,
 * the list and the rule, the pattern, or the repository's attribute that fired. `kept`: a
 * well-known control file the standard marked, which is read (the rule's `control-file`).
 */
export const linguistListMarks = (
  signals: ListSignals & { readonly trust?: AttributeTrust },
  path: string,
): {
  readonly marks: ReadonlyArray<LinguistListMark>;
  readonly kept: LinguistKept | null;
} => {
  if ((signals.trust?.ambiguous.length ?? 0) > 0)
    return { marks: [], kept: null };
  const { lists, control } = listStatesOf(signals, [], path);
  const keptLists = (["generated", "vendored"] as const).flatMap((list) => {
    const state = lists[list];
    return state.state === "kept"
      ? [{ standard: `linguist-${list}` as const, match: state.match }]
      : [];
  });
  const marks = (["generated", "vendored"] as const).flatMap(
    (list): Array<LinguistListMark> => {
      const state = lists[list];
      const by = `linguist ${LINGUIST_STANDARD.version} ${list}`;
      if (state.state === "declared")
        return [
          {
            standard: `linguist-${list}`,
            by: `${by}: ${state.readers.join("; ")}`,
          },
        ];
      if (state.state === "standard")
        return [{ standard: `linguist-${list}`, by: `${by}: ${state.match}` }];
      return [];
    },
  );
  return {
    marks,
    kept:
      control === undefined || keptLists.length === 0
        ? null
        : { entry: control.id, by: keptBy(control.id), lists: keptLists },
  };
};

/** Whether Linguist's rules read a blob for a path: a regular blob at a markable path. */
export const linguistBlobReadable = (path: string, mode: string | null) =>
  mode !== "160000" && mode !== "120000" && markablePath(path);

/**
 * A path's Linguist mark from its blob's bytes: read when given and within `READ_BOUND_BYTES`
 * (the whole blob; above 131,072 bytes `linguistMark` weighs both of Linguist's readers' views),
 * and by its path alone otherwise, where its content rules give no mark.
 */
export const linguistMarkRead = (
  path: string,
  bytes: Uint8Array | undefined,
) =>
  !markablePath(path)
    ? { read: false, mark: null }
    : bytes === undefined || bytes.byteLength > READ_BOUND_BYTES
      ? { read: false, mark: linguistMark(path) }
      : { read: true, mark: linguistMark(path, bytes) };

/**
 * The Linguist marks of blobs at paths, read in groups bounded by size with the repository's
 * batched reader: a blob is read when `linguistBlobReadable`, its size is known and within
 * `READ_BOUND_BYTES`, and the reader returns it; any other is marked by its path alone.
 */
export const readLinguistMarks = (
  repository: string,
  entries: ReadonlyArray<{
    readonly path: string;
    readonly oid: string;
    readonly mode: string | null;
    readonly size: number | null;
  }>,
) =>
  Effect.gen(function* () {
    const found = new Map<
      string,
      { readonly read: boolean; readonly mark: LinguistMark | null }
    >();
    const toRead = entries.filter(
      (entry) =>
        linguistBlobReadable(entry.path, entry.mode) &&
        entry.size !== null &&
        entry.size <= READ_BOUND_BYTES,
    );
    for (const group of groupsBySize(toRead)) {
      const bytes = yield* readBlobs(repository, [
        ...new Set(group.map((entry) => entry.oid)),
      ]);
      for (const entry of group)
        found.set(
          entry.path,
          linguistMarkRead(entry.path, bytes.get(entry.oid)),
        );
    }
    for (const entry of entries)
      if (!found.has(entry.path))
        found.set(entry.path, linguistMarkRead(entry.path, undefined));
    return found;
  });

// ---------------------------------------------------------------------------------------------
// The isolated attribute read.

export const ATTRIBUTES = [
  "linguist-generated",
  "linguist-vendored",
  "diff",
] as const;
const unspecified: AttributeValue = { state: "unspecified", value: null };
export type ReadAttributes = Record<ReadAttributeName, AttributeValue>;
export const allUnspecified = (): ReadAttributes => ({
  "linguist-generated": unspecified,
  "linguist-vendored": unspecified,
  diff: unspecified,
});

/**
 * The argument bytes one `check-attr` group may take. Linux allows 128 KiB for one argument and a
 * total that depends on the stack limit (a quarter of it, at least 128 KiB); macOS's `ARG_MAX` is
 * 1 MiB, arguments and environment together, each string with its NUL and an 8-byte pointer. A
 * group takes at most 64 KiB, and less where the environment is large: 1 MiB less the environment
 * as passed, less 64 KiB for git's own arguments and the runner's. A path longer than the bound
 * goes alone.
 */
const ARG_MAX = 1024 * 1024;
const groupArgumentBytes = (environment: Readonly<Record<string, string>>) => {
  let used = 0;
  for (const [name, value] of Object.entries(environment))
    used += Buffer.byteLength(`${name}=${value}`) + 9;
  return Math.max(0, Math.min(64 * 1024, ARG_MAX - used - 64 * 1024));
};

/**
 * The environment of the isolated read: the caller's without any `GIT_*` variable (none can point
 * it at another directory, tree, configuration or pathspec reading), with the repository's object
 * directory, no system attributes file and no system or user configuration (`attr.tree`,
 * `core.ignoreCase` and the like are the machine's, not the commit's). Kept: the caller's
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, which only adds stores objects are found in; an object is
 * named by its content, so it cannot change what the commit declares.
 */
const isolatedEnvironment = (objects: string) => {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_"))
      environment[name] = value;
  const alternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (alternates !== undefined)
    environment.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternates;
  environment.GIT_OBJECT_DIRECTORY = objects;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  return environment;
};

/** The attribute read could not see, or could not answer for, what the commit declares. */
export class AttributesUnreadable extends Data.TaggedError(
  "AttributesUnreadable",
)<{
  readonly reason: "object-missing" | "answer-missing" | "answer-unasked";
  readonly message: string;
}> {}

/**
 * What the file system's habits would make `git init` write into the isolated directory's
 * configuration, turned off on every command there: on this Mac a fresh `init` writes
 * `ignorecase = true` (patterns would match without regard to case, which GitHub does not) and
 * `precomposeunicode = true` (a decomposed path argument would be composed, and its answer would
 * come back under another path). It also writes `filemode = true` and `bare = true`, which do not
 * change matching. `--git-dir` is given so that `safe.bareRepository` cannot refuse the directory.
 */
const isolatedOptions = (directory: string) => [
  `--git-dir=${directory}`,
  "-c",
  "core.ignoreCase=false",
  "-c",
  "core.precomposeUnicode=false",
  "-c",
  "core.attributesFile=/dev/null",
];

/** One entry of `ls-tree -r -z` without sizes. */
const treeEntriesOf = (out: string) =>
  out
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", oid = ""] = line.slice(0, tab).split(/ +/);
      return { mode, type, oid, path: line.slice(tab + 1) };
    });

/**
 * The commit's attributes for the paths and its `.gitattributes` files, as Git reads them for the
 * commit and nothing else.
 *
 * First, in the repository, with replace objects off (the isolated read has no refs, so it sees
 * the true objects; the scan must see the same): the commit's tree is listed without sizes, and the
 * `.gitattributes` blobs it names are asked for with `cat-file --batch-check`. Both fetch what a
 * partial clone is missing; a listing with sizes would fetch every blob.
 *
 * Then in a Git directory of its own: a bare `git init` with no template, of the repository's
 * object format, over the repository's object directory (Git's answer, `rev-parse --git-path
 * objects`, right for a linked worktree and a bare repository; its `info/alternates` is honoured
 * from there). Nothing outside the commit reaches it: no local `info/attributes`, no system file
 * (`GIT_ATTR_NOSYSTEM`), no user file, no configuration, no `GIT_*` variable of the caller's
 * (`isolatedEnvironment`), and none of what `init` wrote that changes matching
 * (`isolatedOptions`). There the commit's root tree must be present, and every `.gitattributes`
 * blob is read (or, over the size bound, checked present): Git reads an attributes file it cannot
 * find as absent and prints `unspecified`, so a missing object fails the call
 * (`AttributesUnreadable`) instead of answering. Each text is cut at its first NUL, where Git ends
 * an attributes blob. `check-attr` then reads the three attributes for the paths, given as
 * arguments after `--`; every path asked for must come back, byte for byte, with all three, and
 * nothing else may, or the call fails. The directory is made under the temporary root and removed
 * when the read ends, whether it succeeds or fails.
 */
export const readCommitAttributes = (
  repository: string,
  revision: string,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const values = new Map<string, ReadAttributes>();
    if (paths.length === 0)
      return {
        values,
        files: { texts: new Map(), unread: [] } as AttributesFiles,
      };
    // A commit, or a tree where the caller names one (the range manifest reads at trees).
    const { id: commit, what } = yield* resolveCommit(
      repository,
      revision,
    ).pipe(
      Effect.map((id) => ({ id, what: "commit" })),
      Effect.catchTag("GitFailed", () =>
        git(repository, [
          "--no-replace-objects",
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${revision}^{tree}`,
        ]).pipe(Effect.map((out) => ({ id: out.trim(), what: "tree" }))),
      ),
    );
    const listed = treeEntriesOf(
      yield* git(repository, [
        "--no-replace-objects",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commit,
      ]),
    );
    const files = listed.filter(
      (entry) =>
        entry.type === "blob" &&
        (entry.path === ".gitattributes" ||
          entry.path.endsWith("/.gitattributes")),
    );
    const blobs = [...new Set(files.map((entry) => entry.oid))].sort(
      byCodeUnits,
    );
    // Read local sizes only; a missing object is reported below.
    const sizes = new Map<string, number>();
    if (blobs.length > 0)
      for (const line of (yield* gitWithInput(
        repository,
        ["--no-replace-objects", "cat-file", "--batch-check"],
        `${blobs.join("\n")}\n`,
      )).split("\n")) {
        const [oid = "", type = "", size = ""] = line.split(" ");
        if (type === "blob" && /^\d+$/.test(size)) sizes.set(oid, Number(size));
      }
    const answer = yield* git(repository, [
      "rev-parse",
      "--show-object-format",
      "--git-path",
      "objects",
    ]);
    const lines = answer.replace(/\n$/, "").split("\n");
    const format = lines[0] ?? "";
    const objects = resolve(repository, lines.slice(1).join("\n"));
    if (!/^sha(1|256)$/.test(format) || lines.length < 2)
      throw new Error("Unexpected git rev-parse output");
    const environment = isolatedEnvironment(objects);
    const bound = groupArgumentBytes(environment);
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "neuve-attributes-")),
        catch: (cause) =>
          new Error(`No directory for the attribute read: ${cause}`),
      }),
      (directory) =>
        Effect.gen(function* () {
          yield* gitMeasured(
            directory,
            [
              "init",
              "--bare",
              "--quiet",
              "--template=",
              `--object-format=${format}`,
            ],
            environment,
          );
          const options = isolatedOptions(directory);
          const missing = (object: string) => (error: GitFailed) =>
            Effect.fail(
              new AttributesUnreadable({
                reason: "object-missing",
                message: `The attribute read cannot see ${object} of ${what} ${commit} in the repository's objects${error.message === "" ? "" : ` (${error.message})`}`,
              }),
            );
          yield* gitMeasured(
            directory,
            [...options, "cat-file", "-e", `${commit}^{tree}`],
            environment,
          ).pipe(Effect.catchTag("GitFailed", missing("the root tree")));
          const texts = new Map<string, string>();
          const unread: Array<string> = [];
          const textOf = new Map<string, string>();
          for (const oid of blobs) {
            const named = files
              .filter((entry) => entry.oid === oid)
              .map((entry) => entry.path)
              .join(", ");
            const size = sizes.get(oid);
            if (size === undefined || size > READ_BOUND_BYTES) {
              yield* gitMeasured(
                directory,
                [...options, "cat-file", "-e", oid],
                environment,
              ).pipe(Effect.catchTag("GitFailed", missing(named)));
              continue;
            }
            const { stdout } = yield* gitMeasured(
              directory,
              [...options, "cat-file", "blob", oid],
              environment,
            ).pipe(Effect.catchTag("GitFailed", missing(named)));
            const nul = stdout.indexOf("\0");
            textOf.set(oid, nul === -1 ? stdout : stdout.slice(0, nul));
          }
          for (const entry of files) {
            const text = textOf.get(entry.oid);
            if (text === undefined) unread.push(entry.path);
            else texts.set(entry.path, text);
          }
          unread.sort(byCodeUnits);
          for (let at = 0; at < paths.length;) {
            const group: Array<string> = [];
            let bytes = 0;
            while (at < paths.length && group.length < 16_384) {
              const path = paths[at]!;
              const size = Buffer.byteLength(path) + 9;
              if (group.length > 0 && bytes + size > bound) break;
              if (path.includes("\0"))
                return yield* Effect.fail(new Error("Invalid attribute path"));
              group.push(path);
              bytes += size;
              at++;
            }
            const { stdout: out } = yield* gitMeasured(
              directory,
              [
                ...options,
                "check-attr",
                "-z",
                `--source=${commit}`,
                ...ATTRIBUTES,
                "--",
                ...group,
              ],
              environment,
            );
            const asked = new Set(group);
            const answered = new Map<string, Set<string>>();
            const fields = out.split("\0");
            for (let index = 0; index + 2 < fields.length; index += 3) {
              const path = fields[index] ?? "";
              const attribute = fields[index + 1] ?? "";
              const value = fields[index + 2] ?? "";
              if (!(ATTRIBUTES as ReadonlyArray<string>).includes(attribute))
                continue;
              if (!asked.has(path))
                return yield* Effect.fail(
                  new AttributesUnreadable({
                    reason: "answer-unasked",
                    message: `check-attr answered for a path it was not asked about: ${JSON.stringify(path)}`,
                  }),
                );
              const held = values.get(path) ?? allUnspecified();
              held[attribute as ReadAttributeName] =
                value === "set" || value === "unset" || value === "unspecified"
                  ? { state: value, value: null }
                  : { state: "value", value };
              values.set(path, held);
              const seen = answered.get(path) ?? new Set<string>();
              seen.add(attribute);
              answered.set(path, seen);
            }
            for (const path of group)
              if ((answered.get(path)?.size ?? 0) !== ATTRIBUTES.length)
                return yield* Effect.fail(
                  new AttributesUnreadable({
                    reason: "answer-missing",
                    message: `check-attr gave no answer for every attribute of ${JSON.stringify(path)}`,
                  }),
                );
          }
          return {
            values,
            files: { texts, unread } as AttributesFiles,
          };
        }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });

/** Git's blanks in an attributes line. */
const BLANKS = /[ \t\r\n]+/;

/**
 * The tokens of an attributes line that could be attributes; none for a blank or a comment line
 * (`#` after leading blanks). Every blank-separated token, and, where the pattern is C-quoted,
 * those after its closing quote: Git needs no blank there (`"x"attr` gives `x` and `attr`). A
 * token that is a pattern is counted too, which only refuses more.
 */
const attributeLineTokens = (line: string) => {
  const trimmed = line.replace(/^[ \t\r\n]+/, "");
  if (trimmed === "" || trimmed.startsWith("#")) return [];
  const tokens = trimmed.split(BLANKS).filter((token) => token !== "");
  if (trimmed.startsWith('"'))
    for (let at = 1; at < trimmed.length; at++) {
      if (trimmed[at] === "\\") at++;
      else if (trimmed[at] === '"') {
        tokens.push(
          ...trimmed
            .slice(at + 1)
            .split(BLANKS)
            .filter((token) => token !== ""),
        );
        break;
      }
    }
  return tokens;
};

const AMBIGUOUS_WORDS = ["unset", "unspecified"] as const;

/** The revision's `.gitattributes` files: each one's text up to its first NUL, or unread. */
export interface AttributesFiles {
  readonly texts: ReadonlyMap<string, string>;
  readonly unread: ReadonlyArray<string>;
}

/**
 * Per path and attribute, where Git printed `unset` or `unspecified`: the `.gitattributes` files
 * over the path that hold the literal `<attribute>=<word>` outside a comment line, and those over
 * it that were not read. A file covers its own directory and below; the root file covers every
 * path, macro definitions in it included (Git refuses a macro in a nested file, so counting its
 * token there only refuses more), so no macro needs telling apart.
 */
export const ambiguousAttributes = (
  files: AttributesFiles,
  attributes: ReadonlyMap<string, ReadAttributes>,
  paths: ReadonlyArray<string>,
) => {
  const tokens = new Map<string, Set<string>>();
  for (const [file, text] of files.texts)
    for (const line of text.split("\n"))
      for (const token of attributeLineTokens(line))
        for (const attribute of ATTRIBUTES)
          for (const word of AMBIGUOUS_WORDS)
            if (token === `${attribute}=${word}`) {
              const held = tokens.get(token) ?? new Set<string>();
              held.add(file);
              tokens.set(token, held);
            }
  const found = new Map<string, Array<AmbiguousAttribute>>();
  if (tokens.size === 0 && files.unread.length === 0) return found;
  const over = (path: string) => (file: string) => {
    const directory = file.slice(0, -".gitattributes".length);
    return directory === "" || path.startsWith(directory);
  };
  for (const path of paths) {
    const values = attributes.get(path) ?? allUnspecified();
    for (const attribute of ATTRIBUTES)
      for (const word of AMBIGUOUS_WORDS) {
        if (values[attribute].state !== word) continue;
        const holding = [...(tokens.get(`${attribute}=${word}`) ?? [])]
          .filter(over(path))
          .sort(byCodeUnits);
        const notRead = files.unread.filter(over(path));
        if (holding.length === 0 && notRead.length === 0) continue;
        const held = found.get(path) ?? [];
        held.push({ attribute, word, files: holding, unread: notRead });
        found.set(path, held);
      }
  }
  return found;
};
