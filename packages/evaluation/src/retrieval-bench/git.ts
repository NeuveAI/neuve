import { Data, Effect } from "effect";

/** A read-only git command failed. The corpora are never written: no checkout, fetch or ref update. */
export class GitFailed extends Data.TaggedError("GitFailed")<{
  readonly repository: string;
  readonly args: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * Pins what user or system configuration could change: diff algorithm, rename detection, path
 * quoting and locale. Repository-local configuration still applies, as it does for any reader.
 */
const PINNED = [
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
];
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
};

const spawn = (
  repository: string,
  args: ReadonlyArray<string>,
  stdin?: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["git", "-C", repository, ...PINNED, ...args], {
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: ENV,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    catch: (cause) =>
      new GitFailed({ repository, args, message: String(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new GitFailed({ repository, args, message: result.stderr.trim() }),
          ),
    ),
  );

export const gitText = (repository: string, args: ReadonlyArray<string>) =>
  Effect.map(spawn(repository, args), (bytes) =>
    new TextDecoder().decode(bytes),
  );

export interface CommitInfo {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
}

const RECORD = "\u001e";
const FIELD = "\u001f";

/** Commits in `git log` order (newest first) with the given revision arguments. */
export const commits = (repository: string, args: ReadonlyArray<string>) =>
  Effect.map(
    gitText(repository, [
      "log",
      `--format=${RECORD}%H${FIELD}%P${FIELD}%s${FIELD}%b`,
      ...args,
    ]),
    (out): ReadonlyArray<CommitInfo> =>
      out
        .split(RECORD)
        .filter((record) => record.trim() !== "")
        .map((record) => {
          const [sha = "", parents = "", subject = "", body = ""] =
            record.split(FIELD);
          return {
            sha,
            parents: parents.split(" ").filter(Boolean),
            subject,
            body: body.trim(),
          };
        }),
  );

export interface NumstatEntry {
  readonly path: string;
  /** Pre-image path when git detected a rename. */
  readonly from: string | undefined;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
  /** The blob on the side that exists: the new one, or the old one for a deletion. */
  readonly oid: string | undefined;
}

const ZERO_OID = /^0+$/;

/**
 * Parses `--raw --numstat -z --no-abbrev` output. Raw records (`:mode mode old new status\0path\0`,
 * two paths for renames and copies) give each path's blob; numstat records (`a\td\tpath\0`, or
 * `a\td\t\0from\0to\0` for a rename) give its line counts.
 */
export const parseNumstatZ = (text: string): ReadonlyArray<NumstatEntry> => {
  const parts = text.split("\0");
  const blobs = new Map<string, string>();
  const entries: Array<Omit<NumstatEntry, "oid">> = [];
  for (let index = 0; index < parts.length; index++) {
    const field = parts[index]?.replace(/^\n+/, "");
    if (field === undefined || field === "") continue;
    if (field.startsWith(":")) {
      const [, , oldOid = "", newOid = "", status = ""] = field.split(" ");
      const twoPaths = status.startsWith("R") || status.startsWith("C");
      if (twoPaths) index++;
      const path = parts[++index] ?? "";
      blobs.set(path, ZERO_OID.test(newOid) ? oldOid : newOid);
      continue;
    }
    const [added = "", deleted = "", path = ""] = field.split("\t");
    const binary = added === "-";
    const counts = {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    };
    if (path === "") {
      const from = parts[++index] ?? "";
      const to = parts[++index] ?? "";
      entries.push({ path: to, from, ...counts });
    } else entries.push({ path, from: undefined, ...counts });
  }
  return entries.map((entry) => ({ ...entry, oid: blobs.get(entry.path) }));
};

/** Changed lines per file between two commits, with renames detected at git's default 50%. */
export const numstat = (repository: string, base: string, head: string) =>
  Effect.map(
    gitText(repository, [
      "diff",
      "--raw",
      "--numstat",
      "--no-abbrev",
      "-z",
      "-M",
      "--ignore-submodules=all",
      base,
      head,
    ]),
    parseNumstatZ,
  );

/** Unified diff with three context lines for the given paths. */
export const unifiedDiff = (
  repository: string,
  base: string,
  head: string,
  paths: ReadonlyArray<string>,
) =>
  paths.length === 0
    ? Effect.succeed("")
    : gitText(repository, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U3",
        "--ignore-submodules=all",
        "-M",
        base,
        head,
        "--",
        ...paths.map((path) => `:(literal)${path}`),
      ]);

export interface TreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  /** Bytes for blobs; undefined for gitlinks. */
  readonly size: number | undefined;
  readonly path: string;
}

export const treeOf = (repository: string, commit: string) =>
  Effect.map(gitText(repository, ["rev-parse", `${commit}^{tree}`]), (out) =>
    out.trim(),
  );

/** Every entry of a commit's tree, recursively, with blob sizes. */
export const lsTree = (repository: string, commit: string) =>
  Effect.map(
    spawn(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]),
    (bytes): ReadonlyArray<TreeEntry> =>
      new TextDecoder()
        .decode(bytes)
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode = "", type = "", oid = "", size = ""] = line
            .slice(0, tab)
            .split(/ +/);
          return {
            mode,
            type: type as TreeEntry["type"],
            oid,
            size: size === "-" ? undefined : Number(size),
            path: line.slice(tab + 1),
          };
        }),
  );

/** Paths present in a commit's tree, for existence checks. */
export const pathsAt = (repository: string, commit: string) =>
  Effect.map(
    lsTree(repository, commit),
    (entries) => new Set(entries.map((entry) => entry.path)),
  );

/** Reads many blobs in one `git cat-file --batch` call, keyed by OID. */
export const readBlobs = (repository: string, oids: ReadonlyArray<string>) =>
  oids.length === 0
    ? Effect.succeed(new Map<string, Uint8Array>())
    : Effect.flatMap(
        spawn(repository, ["cat-file", "--batch"], `${oids.join("\n")}\n`),
        (bytes) => {
          const blobs = new Map<string, Uint8Array>();
          let offset = 0;
          for (const oid of oids) {
            const newline = bytes.indexOf(10, offset);
            const header = new TextDecoder().decode(
              bytes.subarray(offset, newline),
            );
            const [found, type, size] = header.split(" ");
            if (found !== oid || type !== "blob" || size === undefined)
              return Effect.fail(
                new GitFailed({
                  repository,
                  args: ["cat-file", "--batch"],
                  message: `unexpected header for ${oid}: ${header}`,
                }),
              );
            const start = newline + 1;
            const end = start + Number(size);
            blobs.set(oid, bytes.subarray(start, end));
            offset = end + 1;
          }
          return Effect.succeed(blobs);
        },
      );
