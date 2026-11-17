import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setPriority, tmpdir } from "node:os";
import { Data, Effect, Option } from "effect";
import { prepareLocalGitRead, type GitReadPolicy } from "@neuve/graph-client";
import { type GitReadSession } from "@neuve/graph-client/git-read-session";
import { GitReadSnapshot } from "./git-read-snapshot.ts";

/** Absent, closed and foreign snapshots use the same process path as main. */
export const withGitReadSession = <A>(
  repository: string,
  use: (session: GitReadSession) => Effect.Effect<A, GitFailed>,
  fallback: Effect.Effect<A, GitFailed>,
): Effect.Effect<A, GitFailed> =>
  Effect.gen(function* () {
    const snapshot = yield* GitReadSnapshot;
    if (Option.isNone(snapshot) || snapshot.value.isClosed)
      return yield* fallback;
    const session = snapshot.value;
    return yield* Effect.gen(function* () {
      const local = yield* Effect.tryPromise({
        try: async () => (await realpath(repository)) === session.repository,
        catch: () =>
          new GitFailed({
            args: [],
            exitCode: -1,
            message: "Git repository unavailable",
          }),
      });
      if (!local) {
        session.count("foreignRepository", 1);
        return yield* fallback;
      }
      if (session.isClosed) return yield* fallback;
      yield* Effect.tryPromise({
        try: () => session.prepare(),
        catch: (cause) =>
          new GitFailed({
            args: [],
            exitCode: -1,
            message: String(cause).slice(0, 500),
          }),
      });
      if (session.isClosed) return yield* fallback;
      return yield* use(session);
    }).pipe(
      Effect.catch((error) =>
        session.isClosed ? fallback : Effect.fail(error),
      ),
    );
  });

/** Skip Git's leading global options rather than searching path or argument values. */
export const gitSubcommand = (args: ReadonlyArray<string>) => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (
      arg === "-c" ||
      arg === "-C" ||
      arg === "--git-dir" ||
      arg === "--work-tree"
    ) {
      index += 2;
      continue;
    }
    if (
      arg.startsWith("--attr-source=") ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
    ) {
      index++;
      continue;
    }
    if (
      [
        "--no-lazy-fetch",
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-pager",
        "--literal-pathspecs",
      ].includes(arg)
    ) {
      index++;
      continue;
    }
    return [
      "rev-parse",
      "diff",
      "show",
      "ls-tree",
      "merge-base",
      "check-attr",
      "version",
      "log",
      "grep",
      "cat-file",
      "for-each-ref",
      "hash-object",
      "config",
      "init",
      "clone",
      "rev-list",
    ].includes(arg)
      ? arg
      : "other";
  }
  return "other";
};

const exact = "(?:[a-f0-9]{40}|[a-f0-9]{64})";
const immutableCommand = (args: ReadonlyArray<string>) => {
  const command = gitSubcommand(args);
  const oid = new RegExp(`^${exact}$`);
  if (command === "ls-tree") return oid.test(args.at(-1) ?? "");
  if (command === "rev-parse")
    return new RegExp(`^${exact}\\^\\{tree\\}$`).test(args.at(-1) ?? "");
  if (command === "merge-base")
    return (
      args.slice(1).length === 2 &&
      args.slice(1).every((value) => oid.test(value))
    );
  if (command === "log")
    return new RegExp(`^${exact}\\.\\.${exact}$`).test(args.at(-1) ?? "");
  if (command === "diff")
    return (
      args.includes("--no-ext-diff") &&
      args.includes("--no-textconv") &&
      args.slice(-2).every((value) => oid.test(value)) &&
      args.some(
        (value) =>
          value.startsWith("--attr-source=") && oid.test(value.slice(14)),
      )
    );
  return false;
};

/** Reuse the local snapshot's assessment; assess unscoped and foreign reads themselves. */
const gitReadPolicy = (repository: string, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const snapshot = yield* GitReadSnapshot;
    return yield* Effect.tryPromise({
      try: async () => {
        if (
          environment === undefined &&
          Option.isSome(snapshot) &&
          !snapshot.value.isClosed &&
          (await realpath(repository)) === snapshot.value.repository
        )
          return snapshot.value.prepare();
        return prepareLocalGitRead(repository, environment);
      },
      catch: (cause) =>
        new GitFailed({
          args: [],
          exitCode: -1,
          message: String(cause).slice(0, 500),
        }),
    });
  });

/**
 * Git reads for the harness: always against object IDs, never the working tree, so untracked and
 * ignored files never enter a review (10.34). Each git process runs at nice 10 with two grep
 * threads (6.10, proposal §3.6).
 */

export class GitFailed extends Data.TaggedError("GitFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly message: string;
  /** The failed process's CPU, when it ran (a `git grep` with no match exits 1). */
  readonly cpu?: GitCpu | null;
}> {}

/** A git process's CPU, its own and its waited-on children's, in milliseconds. */
export interface GitCpu {
  readonly userMs: number;
  readonly systemMs: number;
}

/**
 * `git` with the process's CPU from its resource usage, for a lookup's span (10.97). Bun reports
 * the times in microseconds, as bigints at run time whatever the declared type says.
 */
const runGitMeasured = (
  repository: string,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  executable = "git",
  input?: string,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn(
        [executable, "-C", repository, "-c", "grep.threads=2", ...args],
        {
          stdin: input === undefined ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
          signal,
          ...(environment === undefined ? {} : { env: environment }),
        },
      );
      try {
        setPriority(child.pid, 10);
      } catch {
        // A sandbox may refuse to change priority; the read still runs.
      }
      try {
        const writing =
          input === undefined
            ? Promise.resolve()
            : (async () => {
                if (child.stdin == null || typeof child.stdin === "number")
                  throw new Error("Git input unavailable");
                child.stdin.write(input);
                await child.stdin.end();
              })();
        const [stdout, stderr, exitCode, writeError] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
          writing.then(
            () => undefined,
            (cause: unknown) => cause,
          ),
        ]);
        if (exitCode === 0 && writeError !== undefined) throw writeError;
        const usage = child.resourceUsage()?.cpuTime;
        const cpu: GitCpu | null =
          usage === undefined
            ? null
            : {
                userMs: Number(usage.user) / 1_000,
                systemMs: Number(usage.system) / 1_000,
              };
        return { stdout, stderr, exitCode, cpu };
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
    catch: (cause) =>
      new GitFailed({ args, exitCode: -1, message: String(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed({ stdout: result.stdout, cpu: result.cpu })
        : Effect.fail(
            new GitFailed({
              args,
              exitCode: result.exitCode,
              message: result.stderr.trim().slice(0, 500),
              cpu: result.cpu,
            }),
          ),
    ),
    Effect.withSpan("harness.git", {
      attributes: {
        "harness.git.command": gitSubcommand(args),
      },
    }),
  );

/** Older Git reads revision attributes from a private index and an empty worktree. */
const runGitWithAttributes = (
  repository: string,
  args: ReadonlyArray<string>,
  policy: GitReadPolicy,
  input?: string,
) => {
  const run = (argv: ReadonlyArray<string>, environment = policy.environment) =>
    runGitMeasured(
      repository,
      [...policy.commandPrefix, ...argv],
      environment,
      policy.executable,
      input,
    );
  const source = args.find(
    (arg) =>
      arg.startsWith("--attr-source=") ||
      (gitSubcommand(args) === "check-attr" && arg.startsWith("--source=")),
  );
  return run(args).pipe(
    Effect.catchTag("GitFailed", (error) => {
      if (
        source === undefined ||
        error.exitCode !== 129 ||
        !error.message.includes("unknown option")
      )
        return Effect.fail(error);
      const revision = source.slice(source.indexOf("=") + 1);
      return Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), "neuve-attribute-index-")),
          catch: (cause) =>
            new GitFailed({ args, exitCode: -1, message: String(cause) }),
        }),
        (directory) =>
          Effect.gen(function* () {
            const environment = {
              ...policy.environment,
              GIT_INDEX_FILE: join(directory, "index"),
            };
            const { stdout: gitDirectory } = yield* runGitMeasured(
              repository,
              [...policy.commandPrefix, "rev-parse", "--absolute-git-dir"],
              policy.environment,
              policy.executable,
            );
            const options = [
              `--git-dir=${gitDirectory.replace(/\n$/, "")}`,
              `--work-tree=${directory}`,
              "-c",
              `safe.directory=${directory}`,
              "-c",
              "core.bare=false",
              "-c",
              "core.splitIndex=false",
              "-c",
              "core.sparseCheckout=false",
              "-c",
              "index.sparse=false",
            ];
            yield* runGitMeasured(
              directory,
              [
                ...policy.commandPrefix,
                ...options,
                "read-tree",
                "--no-sparse-checkout",
                revision,
              ],
              environment,
              policy.executable,
            );
            const translated = args.flatMap((arg) =>
              arg === source
                ? source.startsWith("--source=")
                  ? ["--cached"]
                  : []
                : [arg],
            );
            return yield* runGitMeasured(
              directory,
              [...policy.commandPrefix, ...options, ...translated],
              environment,
              policy.executable,
              input,
            );
          }),
        (directory) =>
          Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
    }),
  );
};

/**
 * A tree diff must not inherit local diff drivers or info/attributes. Use only the source's
 * objects in a temporary Git directory, retaining its assessed executable and offline policy.
 * The empty template and isolated environment exclude system and user configuration too.
 */
export const gitWithCanonicalConfig = (
  repository: string,
  args: ReadonlyArray<string>,
) => {
  const read = Effect.gen(function* () {
    const policy = yield* gitReadPolicy(repository);
    const { stdout } = yield* runGitMeasured(
      repository,
      [
        ...policy.commandPrefix,
        "rev-parse",
        "--show-object-format",
        "--git-path",
        "objects",
      ],
      policy.environment,
      policy.executable,
    );
    const [format, ...path] = stdout.replace(/\n$/, "").split("\n");
    if ((format !== "sha1" && format !== "sha256") || path.length === 0)
      return yield* Effect.fail(
        new GitFailed({
          args,
          exitCode: -1,
          message: "Invalid Git object store",
        }),
      );
    const objects = resolve(repository, path.join("\n"));
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "neuve-canonical-diff-")),
        catch: (cause) =>
          new GitFailed({ args, exitCode: -1, message: String(cause) }),
      }),
      (directory) =>
        Effect.gen(function* () {
          yield* runGitMeasured(
            directory,
            [
              ...policy.commandPrefix,
              "init",
              "--bare",
              "--quiet",
              "--template=",
              `--object-format=${format}`,
            ],
            policy.environment,
            policy.executable,
          );
          const result = yield* runGitWithAttributes(
            directory,
            [
              `--git-dir=${directory}`,
              "-c",
              "core.ignoreCase=false",
              "-c",
              "core.precomposeUnicode=false",
              "-c",
              "core.bigFileThreshold=512m",
              ...args,
            ],
            {
              ...policy,
              environment: {
                ...policy.environment,
                GIT_OBJECT_DIRECTORY: objects,
              },
            },
          );
          return result.stdout;
        }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
  });
  return memoizedGitRead(
    repository,
    args,
    read,
    JSON.stringify(["canonical-config", ...args]),
  );
};

export const gitMeasured = (
  repository: string,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    if (["version", "config", "init", "clone"].includes(gitSubcommand(args)))
      return yield* runGitMeasured(repository, args, environment);
    const policy = yield* gitReadPolicy(repository, environment);
    return yield* runGitWithAttributes(repository, args, policy);
  });

/** Finite NUL-delimited attribute input, with stdout/stderr drained while writing. */
export const gitWithInput = (
  repository: string,
  args: ReadonlyArray<string>,
  input: string,
) =>
  Effect.gen(function* () {
    const policy = yield* gitReadPolicy(repository);
    const { stdout } = yield* runGitWithAttributes(
      repository,
      args,
      policy,
      input,
    );
    return stdout;
  });

export const git = (
  repository: string,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) => {
  if (environment !== undefined || !immutableCommand(args))
    return Effect.map(
      gitMeasured(repository, args, environment),
      ({ stdout }) => stdout,
    );
  return memoizedGitRead(
    repository,
    args,
    Effect.map(gitMeasured(repository, args), ({ stdout }) => stdout),
    JSON.stringify(args),
  );
};

const memoizedGitRead = (
  repository: string,
  args: ReadonlyArray<string>,
  read: Effect.Effect<string, GitFailed>,
  key: string,
) => {
  if (!immutableCommand(args)) return read;
  return Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    return yield* withGitReadSession(
      repository,
      (session) =>
        Effect.tryPromise({
          try: (signal) =>
            session.command(
              key,
              (sharedSignal) =>
                Effect.runPromiseWith(context)(read, { signal: sharedSignal }),
              signal,
            ),
          catch: (cause) =>
            cause instanceof GitFailed
              ? cause
              : new GitFailed({
                  args,
                  exitCode: -1,
                  message: "Git command snapshot failed or was cancelled",
                }),
        }),
      read,
    );
  });
};

/** Resolves a revision to its commit OID. */
export const resolveCommit = (repository: string, revision: string) =>
  Effect.map(
    git(repository, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]),
    (out) => out.trim(),
  );

export interface ChangedFile {
  readonly path: string;
  /** Null for a binary file. */
  readonly added: number | null;
  readonly deleted: number | null;
}

/** The files a range changes, from `git diff --numstat` between the two OIDs. */
export const changedFiles = (repository: string, base: string, head: string) =>
  Effect.map(
    git(repository, ["diff", "--numstat", "-z", "--no-renames", base, head]),
    (out): ReadonlyArray<ChangedFile> =>
      out
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => {
          const [added = "-", deleted = "-", ...rest] = entry.split("\t");
          return {
            path: rest.join("\t"),
            added: added === "-" ? null : Number(added),
            deleted: deleted === "-" ? null : Number(deleted),
          };
        }),
  );

/** One file's diff between the OIDs. */
export const fileDiff = (
  repository: string,
  base: string,
  head: string,
  path: string,
) => git(repository, ["diff", "--no-renames", base, head, "--", path]);

/** A file's text at a revision, read from the blob. */
export const showBlob = (repository: string, revision: string, path: string) =>
  git(repository, ["show", `${revision}:${path}`]);

export interface FindLog {
  readonly commits: ReadonlyArray<import("./git-objects.ts").CommitText>;
  readonly files: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly mergeFiles?: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** One range log read, shared by Find's four lenses. NUL paths preserve unusual file names.
 * Merge paths are kept separately for path lookups and counts, never coverage or citations.
 */
export const rangeCommitFiles = (
  repository: string,
  base: string,
  head: string,
) =>
  Effect.map(
    git(repository, [
      "log",
      "--no-color",
      "--no-renames",
      "--diff-merges=first-parent",
      "--name-only",
      "-z",
      "--format=%x00%H%x00%P%x00%s%x00%B%x00",
      `${base}..${head}`,
    ]),
    (out): FindLog => {
      const files = new Map<string, ReadonlyArray<string>>();
      const mergeFiles = new Map<string, ReadonlyArray<string>>();
      const commits: Array<FindLog["commits"][number]> = [];
      const fields = out.split("\0");
      let oid: string | undefined;
      let paths: string[] = [];
      let merge = false;
      const flush = () => {
        if (oid === undefined) return;
        files.set(oid, merge ? [] : paths);
        if (merge) mergeFiles.set(oid, paths);
      };
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        if (field === "" && /^[a-f0-9]{40,64}$/.test(fields[i + 1] ?? "")) {
          flush();
          oid = fields[++i]!;
          merge = (fields[++i] ?? "").includes(" ");
          const subject = fields[++i] ?? "";
          const message = fields[++i] ?? "";
          commits.push({ oid, subject, body: message });
          paths = [];
        } else if (oid !== undefined && field !== "") {
          // Git adds one formatting newline before the first path, outside its NUL name.
          paths.push(paths.length === 0 ? field.replace(/^\n/, "") : field);
        }
      }
      flush();
      return { commits, files, mergeFiles };
    },
  );

// Bound titles before any pattern scans repository-controlled text; preserve code points.
export const capCommitTitle = (title: string) =>
  [...title.slice(0, 400)].slice(0, 200).join("");

// Decision 12.49: identity trailers and email-bearing lines do not reach Find.
export const reviewMessage = (message: string) => {
  const lines = message.split(/\r?\n/);
  const kept = lines.filter(
    (line) =>
      !/^\s*[\w-]+-by\s*:/i.test(line) &&
      // Only try at the start of a local-part run, so a failed run is scanned once.
      !/(?<![\p{L}\p{N}.+_-])[\p{L}\p{N}.+_-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}-])/u.test(
        line,
      ),
  );
  return [
    ...kept,
    ...(kept.length < lines.length
      ? ["[Identity trailers and email-bearing lines omitted.]"]
      : []),
  ].join("\n");
};
