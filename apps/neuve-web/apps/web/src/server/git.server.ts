/*
 * The web app's one way to run git. A stalled git (a held lock, a slow or
 * unmounted disk) must not hold a page: each process gets `GIT_DEADLINE_MS`,
 * then git is killed and reads as failed (exit 143), which every caller
 * already takes as git saying nothing.
 *
 * Ten seconds is about four times the heaviest read measured, the patch-ids
 * of a 1,400-commit range (about 2 s). A failure is never kept, so a read
 * past it costs it on every load. When every git stalls, the Reviews load
 * stops at the first failed read of each of its chains and answers in about
 * 30 s.
 */

export const GIT_DEADLINE_MS = 10_000

/** `git -C at …`, `input` on its stdin, killed past the deadline. */
export const spawnGit = (
  at: string,
  args: ReadonlyArray<string>,
  input?: string | ReadableStream<Uint8Array>
) =>
  Bun.spawn(["git", "-C", at, ...args], {
    stdin:
      input === undefined
        ? "ignore"
        : typeof input === "string"
          ? new Blob([input])
          : input,
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_DEADLINE_MS,
  })

/**
 * Its exit code and stdout. A process git started may hold the pipe past
 * git's exit: a failed git's output is not waited for, and a successful
 * one's only until the deadline, past which it reads as killed.
 */
export const git = async (
  at: string,
  args: ReadonlyArray<string>,
  input?: string | ReadableStream<Uint8Array>
) => {
  const deadline = Date.now() + GIT_DEADLINE_MS
  const child = spawnGit(at, args, input)
  const out = new Response(child.stdout).text()
  out.catch(() => undefined)
  const code = await child.exited
  if (code !== 0) return { code, out: "" }
  const read = await Promise.race([
    out,
    Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
  ])
  return read === undefined ? { code: 143, out: "" } : { code, out: read }
}
