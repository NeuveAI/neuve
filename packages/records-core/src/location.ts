import { isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";
import { RepositoryUnavailable } from "./errors.ts";

/**
 * The store holds raw captures (transcripts with prompts and tool output), so it is owner-only like
 * the harnesses' own transcripts: folders 0700, files 0600.
 */
export const STORE_DIRECTORY_MODE = 0o700;
export const STORE_FILE_MODE = 0o600;

export interface StoreLocation {
  /** `.git/neuve/` in the git common directory, shared by every worktree of the repository (8.6). */
  readonly directory: string;
  readonly database: string;
  readonly spool: string;
  /** Blobs too large to keep inline, as `sha256/<first two hex>/<remaining hex>` (D11). */
  readonly blobs: string;
}

export const storeLocationIn = (gitCommonDirectory: string): StoreLocation => {
  const directory = join(gitCommonDirectory, "neuve");
  return {
    directory,
    database: join(directory, "records.sqlite"),
    spool: join(directory, "spool"),
    blobs: join(directory, "blobs"),
  };
};

/** `git rev-parse` ran but did not succeed. */
export interface GitCommandFailed {
  readonly exitCode: number;
  readonly stderr: string;
}

/** Resolves the store location for a repository or any of its worktrees. */
export const resolveStoreLocation = (repository: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(
          ["git", "-C", repository, "rev-parse", "--git-common-dir"],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
      catch: (cause) => new RepositoryUnavailable({ repository, cause }),
    });
    if (result.exitCode !== 0) {
      const cause: GitCommandFailed = {
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
      };
      return yield* new RepositoryUnavailable({ repository, cause });
    }
    const commonDirectory = result.stdout.trim();
    return storeLocationIn(
      isAbsolute(commonDirectory)
        ? commonDirectory
        : resolve(repository, commonDirectory),
    );
  });
