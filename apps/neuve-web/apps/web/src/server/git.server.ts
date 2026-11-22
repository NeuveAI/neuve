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
 * A pipe read as text: `text` is undefined if the pipe failed or was
 * cancelled, and `cancel` stops reading it.
 */
const collect = (pipe: ReadableStream<Uint8Array>) => {
  const abort = new AbortController()
  const decoder = new TextDecoder()
  let text = ""
  const done = pipe
    .pipeTo(
      new WritableStream({
        write: (chunk: Uint8Array) => {
          text += decoder.decode(chunk, { stream: true })
        },
      }),
      { signal: abort.signal }
    )
    .then(
      () => text + decoder.decode(),
      () => undefined
    )
  return { done, cancel: () => abort.abort() }
}

/**
 * Its exit code and stdout. A process git started may hold the pipe past
 * git's exit: a failed git's output is not waited for, and a successful
 * one's only until the deadline, past which it reads as killed. Either way
 * the pipe is then cancelled, so nothing keeps filling it.
 */
export const git = async (
  at: string,
  args: ReadonlyArray<string>,
  input?: string | ReadableStream<Uint8Array>
) => {
  const deadline = Date.now() + GIT_DEADLINE_MS
  const child = spawnGit(at, args, input)
  const out = collect(child.stdout)
  const code = await child.exited
  if (code !== 0) {
    out.cancel()
    return { code, out: "" }
  }
  // The timer is cleared once stdout ends, so it never keeps a process alive.
  let stop = () => {}
  const read = await Promise.race([
    out.done,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
      stop = () => clearTimeout(timer)
    }),
  ])
  stop()
  if (read !== undefined) return { code, out: read }
  out.cancel()
  return { code: 143, out: "" }
}
