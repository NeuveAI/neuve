import { setPriority } from "node:os";
import { Effect } from "effect";
import { prepareLocalGitRead } from "@neuve/graph-client";
import {
  GitFailed,
  git,
  gitWithCanonicalConfig,
  withGitReadSession,
} from "./git.ts";

/**
 * Git object reads for Precompute (proposal §5.2, 10.34): trees, blobs, merge bases, commit texts
 * and diffs, always at object IDs, never the working tree, so untracked and ignored files never
 * enter a review. Every process runs at nice 10 like the harness's other git reads (6.10).
 */

/** One entry of a recursive tree listing. */
export interface TreeEntry {
  readonly mode: string;
  /** `blob`, `commit` (a submodule link) or `tree`. */
  readonly type: string;
  readonly oid: string;
  /** Bytes for a blob; null otherwise. */
  readonly size: number | null;
  readonly path: string;
}

/** Every entry of a tree, recursively (`git ls-tree -r -l -z`). */
export const lsTree = (repository: string, treeish: string) =>
  Effect.map(
    git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", treeish]),
    (out): ReadonlyArray<TreeEntry> =>
      out
        .split("\0")
        .filter((line) => line !== "")
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode = "", type = "", oid = "", size = "-"] = line
            .slice(0, tab)
            .split(/ +/);
          return {
            mode,
            type,
            oid,
            size: size === "-" ? null : Number(size),
            path: line.slice(tab + 1),
          };
        }),
  );

/** The tree of a commit. */
export const treeOf = (repository: string, commit: string) =>
  Effect.map(
    git(repository, ["rev-parse", "--verify", `${commit}^{tree}`]),
    (out) => out.trim(),
  );

/** The empty tree in this repository's hash, for a root commit's parent side. */
export const emptyTree = (repository: string) =>
  Effect.map(git(repository, ["hash-object", "-t", "tree", "--stdin"]), (out) =>
    out.trim(),
  );

/** The merge base of the range's two commits; the base itself when it is an ancestor of the head. */
export const mergeBase = (repository: string, base: string, head: string) =>
  Effect.map(git(repository, ["merge-base", base, head]), (out) => out.trim());

/** One commit's text, as commit or PR text is weak scope (9.13). */
export interface CommitText {
  readonly oid: string;
  readonly subject: string;
  readonly body: string;
}

/** The commits of `base..head`, oldest first, with their messages. */
export const commitTexts = (repository: string, base: string, head: string) =>
  Effect.map(
    git(repository, [
      "log",
      "--reverse",
      "--no-color",
      "--format=%H%x00%B%x1e",
      `${base}..${head}`,
    ]),
    (out): ReadonlyArray<CommitText> =>
      out
        .split("\x1e")
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record.includes("\0"))
        .map((record) => {
          const [oid = "", message = ""] = record.split("\0");
          const [subject = "", ...rest] = message.trimEnd().split("\n");
          return { oid, subject, body: rest.join("\n").trim() };
        }),
  );

/** At most this many bytes of blob content are read into memory per group (6.10). */
export const READ_GROUP_BYTES = 16 * 1024 * 1024;

/**
 * Splits tree entries into groups whose blob sizes add up to at most `maxBytes` (a larger blob is
 * a group of its own), so a caller that holds a group's bytes holds a bounded amount.
 */
export const groupsBySize = <T extends { readonly size: number | null }>(
  entries: ReadonlyArray<T>,
  maxBytes = READ_GROUP_BYTES,
): ReadonlyArray<ReadonlyArray<T>> => {
  const groups: Array<Array<T>> = [];
  let current: Array<T> = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = entry.size ?? 0;
    if (current.length > 0 && bytes + size > maxBytes) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

/**
 * Reuses `git cat-file --batch-command` in an explicit review snapshot. Other calls retain one
 * `cat-file --batch` process per group. `headBytes` exposes only each blob's prefix; the snapshot
 * can retain a small full body for later reads. Without it, callers bound whole-body results with
 * `groupsBySize`. Missing objects are left out. A snapshot also omits full reads above its
 * object-memory bound and counts them as oversized. Returned bytes can share snapshot storage.
 * Callers must only read them; decoding does not change the stored bytes.
 */
export const readBlobs = (
  repository: string,
  oids: ReadonlyArray<string>,
  options: { readonly headBytes?: number } = {},
) =>
  oids.length === 0
    ? Effect.succeed(new Map<string, Uint8Array>())
    : withGitReadSession(
        repository,
        (session) =>
          Effect.tryPromise({
            try: (signal) => session.blobs(oids, options.headBytes, signal),
            catch: () =>
              new GitFailed({
                args: ["cat-file", "--batch-command"],
                exitCode: -1,
                message: "Git read snapshot failed or was cancelled",
              }),
          }).pipe(
            Effect.withSpan("harness.git", {
              attributes: { "harness.git.command": "cat-file" },
            }),
          ),
        readBlobsUnscoped(repository, oids, options),
      );

const readBlobsUnscoped = (
  repository: string,
  oids: ReadonlyArray<string>,
  options: { readonly headBytes?: number } = {},
) =>
  Effect.gen(function* () {
    const out = new Map<string, Uint8Array>();
    const unique = [...new Set(oids)];
    const GROUP = 256;
    for (let at = 0; at < unique.length; at += GROUP) {
      yield* catFileBatch(
        repository,
        unique.slice(at, at + GROUP),
        options.headBytes,
        (oid, bytes) => out.set(oid, bytes),
      );
      yield* Effect.yieldNow;
    }
    return out as ReadonlyMap<string, Uint8Array>;
  });

const catFileBatch = (
  repository: string,
  oids: ReadonlyArray<string>,
  headBytes: number | undefined,
  keep: (oid: string, bytes: Uint8Array) => void,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const policy = await prepareLocalGitRead(repository);
      const child = Bun.spawn(
        [
          policy.executable,
          ...policy.commandPrefix,
          "-C",
          repository,
          "cat-file",
          "--batch",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          signal,
          env: policy.environment,
        },
      );
      try {
        setPriority(child.pid, 10);
      } catch {
        // A sandbox may refuse to change priority; the read still runs.
      }
      child.stdin.write(`${oids.join("\n")}\n`);
      await child.stdin.end();
      // The stream is `<oid> <type> <size>\n<content>\n` per object, or `<oid> missing\n`.
      let header: Array<number> = [];
      let current:
        | {
            oid: string;
            blob: boolean;
            left: number;
            kept: Uint8Array;
            at: number;
          }
        | undefined;
      let separator = false;
      for await (const chunk of child.stdout) {
        let offset = 0;
        while (offset < chunk.length) {
          if (separator) {
            separator = false;
            offset++;
            continue;
          }
          if (current !== undefined) {
            const take = Math.min(current.left, chunk.length - offset);
            const room = current.kept.length - current.at;
            if (room > 0)
              current.kept.set(
                chunk.subarray(offset, offset + Math.min(take, room)),
                current.at,
              );
            current.at += Math.min(take, room);
            current.left -= take;
            offset += take;
            if (current.left === 0) {
              if (current.blob) keep(current.oid, current.kept);
              current = undefined;
              separator = true;
            }
            continue;
          }
          const newline = chunk.indexOf(10, offset);
          if (newline < 0) {
            header.push(...chunk.subarray(offset));
            break;
          }
          header.push(...chunk.subarray(offset, newline));
          offset = newline + 1;
          const [oid = "", type = "", size = ""] = new TextDecoder()
            .decode(Uint8Array.from(header))
            .split(" ");
          header = [];
          if (type === "missing") continue;
          const length = Number(size);
          current = {
            oid,
            blob: type === "blob",
            left: length,
            kept: new Uint8Array(
              type === "blob" ? Math.min(length, headBytes ?? length) : 0,
            ),
            at: 0,
          };
          if (length === 0) {
            if (current.blob) keep(oid, current.kept);
            current = undefined;
            separator = true;
          }
        }
      }
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`git cat-file exited ${exitCode}`);
    },
    catch: (cause) =>
      new GitFailed({
        args: ["cat-file", "--batch"],
        exitCode: -1,
        message: String(cause).slice(0, 500),
      }),
  }).pipe(
    Effect.withSpan("harness.git", {
      attributes: { "harness.git.command": "cat-file" },
    }),
  );

/** One file of a diff between two trees, with its hunks as git printed them. */
export interface DiffFile {
  readonly status:
    "added" | "deleted" | "modified" | "renamed" | "type-changed";
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly binary: boolean;
  readonly hunks: ReadonlyArray<DiffHunk>;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** The `@@ … @@` line and body lines, with a trailing newline. */
  readonly text: string;
  readonly added: number;
  readonly deleted: number;
}

const ZERO = /^0+$/;

/** Unquotes a path git printed in C style (`"a\tb"`), or returns it as is. */
export const unquotePath = (text: string) => {
  if (!text.startsWith('"')) return text;
  const bytes: Array<number> = [];
  const escapes: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    b: 8,
    f: 12,
    v: 11,
    a: 7,
    '"': 34,
    "\\": 92,
  };
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = text[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(text.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
};

const stripPrefix = (path: string) => {
  const unquoted = unquotePath(path.replace(/\t$/, ""));
  return unquoted.replace(/^[ab]\//, "");
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The canonical diff between two trees or commits. Only target-tree attributes and built-in
 * drivers apply. Whitespace changes count; user and local configuration cannot change hunks.
 * Changes to this recipe must invalidate both manifestSpec and commitHunksSpec.
 */
export const diffTrees = (repository: string, from: string, to: string) =>
  Effect.map(
    gitWithCanonicalConfig(repository, [
      // Attributes (such as `-diff`) come from the new side's tree, never the working tree.
      `--attr-source=${to}`,
      "-c",
      "core.quotePath=true",
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--full-index",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--find-renames=50%",
      "-l1000",
      "-U3",
      "--inter-hunk-context=0",
      "--no-function-context",
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      from,
      to,
    ]),
    parseDiff,
  );

export const parseDiff = (out: string): ReadonlyArray<DiffFile> => {
  const files: Array<DiffFile> = [];
  type Mutable = { -readonly [K in keyof DiffFile]: DiffFile[K] } & {
    hunks: Array<DiffHunk>;
  };
  let file: Mutable | undefined;
  let hunk:
    | ({ -readonly [K in keyof DiffHunk]: DiffHunk[K] } & {
        lines: Array<string>;
      })
    | undefined;
  const flushHunk = () => {
    if (file !== undefined && hunk !== undefined) {
      const { lines, ...rest } = hunk;
      file.hunks.push({ ...rest, text: `${lines.join("\n")}\n` });
    }
    hunk = undefined;
  };
  const flushFile = () => {
    flushHunk();
    if (file !== undefined) files.push(file);
    file = undefined;
  };
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      // Paths are settled by the `---`, `+++` and rename lines; these are a fallback for a file
      // without them (a mode change or an empty file).
      const rest = line.slice("diff --git ".length);
      const split = rest.startsWith('"')
        ? rest.indexOf('" ', 1) + 1
        : rest.indexOf(" b/");
      const oldPath = stripPrefix(rest.slice(0, split));
      const newPath = stripPrefix(rest.slice(split + 1));
      file = {
        status: "modified",
        oldPath,
        newPath,
        oldMode: null,
        newMode: null,
        oldOid: null,
        newOid: null,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (file === undefined) continue;
    if (hunk !== undefined) {
      if (
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\")
      ) {
        hunk.lines.push(line);
        if (line.startsWith("+")) hunk.added++;
        else if (line.startsWith("-")) hunk.deleted++;
        continue;
      }
      flushHunk();
    }
    const header = HUNK.exec(line);
    if (header !== null) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        added: 0,
        deleted: 0,
        text: "",
        lines: [line],
      };
      continue;
    }
    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length);
      file.oldPath = null;
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length);
      file.newPath = null;
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length);
      if (file.status === "modified") file.status = "type-changed";
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("index ")) {
      const [oids = "", mode] = line.slice("index ".length).split(" ");
      const [oldOid = "", newOid = ""] = oids.split("..");
      file.oldOid = ZERO.test(oldOid) ? null : oldOid;
      file.newOid = ZERO.test(newOid) ? null : newOid;
      if (mode !== undefined) {
        file.oldMode ??= mode;
        file.newMode ??= mode;
      }
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      if (line !== "--- /dev/null") file.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") file.newPath = stripPrefix(line.slice(4));
    }
  }
  flushFile();
  // A mode-only change between two modes of the same kind is not a type change.
  return files.map((entry) =>
    entry.status === "type-changed" &&
    entry.oldMode?.slice(0, 2) === entry.newMode?.slice(0, 2)
      ? { ...entry, status: "modified" }
      : entry,
  );
};
