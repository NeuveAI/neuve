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

/**
 * A pipe read as text: `done` gives it all, or undefined if the pipe failed or was cancelled;
 * `text` gives what was read so far; `cancel` stops reading it.
 */
const collect = (pipe: ReadableStream<Uint8Array>) => {
  const abort = new AbortController();
  const decoder = new TextDecoder();
  let text = "";
  const done = pipe
    .pipeTo(
      new WritableStream({
        write: (chunk: Uint8Array) => {
          text += decoder.decode(chunk, { stream: true });
        },
      }),
      { signal: abort.signal },
    )
    .then(
      () => text + decoder.decode(),
      () => undefined,
    );
  return { done, text: () => text, cancel: () => abort.abort() };
};

/** Resolves the store location for a repository or any of its worktrees. */
export const resolveStoreLocation = (repository: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async () => {
        // A stalled git fails like one that refuses the repository (exit 143), so no caller waits
        // on it. A process git started may hold the pipes past git's exit: they are read while it
        // runs, stdout only until the deadline, and a failure reports the stderr read by then.
        const deadline = Date.now() + 10_000;
        const child = Bun.spawn(
          ["git", "-C", repository, "rev-parse", "--git-common-dir"],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 },
        );
        const stdout = collect(child.stdout);
        const stderr = collect(child.stderr);
        const exitCode = await child.exited;
        // The pipes are cancelled once the answer is known, so nothing keeps filling them.
        const done = (exit: number, out: string) => {
          stdout.cancel();
          stderr.cancel();
          return {
            stdout: out,
            stderr: exit === 0 ? "" : stderr.text(),
            exitCode: exit,
          };
        };
        if (exitCode !== 0) return done(exitCode, "");
        // The timer is cleared once stdout ends, so it never keeps a short command alive.
        let stop = () => {};
        const out = await Promise.race([
          stdout.done,
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(
              resolve,
              Math.max(0, deadline - Date.now()),
            );
            stop = () => clearTimeout(timer);
          }),
        ]);
        stop();
        return out === undefined ? done(143, "") : done(exitCode, out);
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
