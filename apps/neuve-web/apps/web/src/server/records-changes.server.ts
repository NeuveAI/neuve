import { relative } from "node:path"
import { Store } from "@neuve/records-core"
import type { StoreLocation } from "@neuve/records-core"
import { heldReviewsPath } from "@neuve/harness/held-reviews"

/**
 * "Records changed", pushed (8.3's "watching a sequence number"; 0016: the push only wakes
 * subscribers, who then read). A change is a hint and carries nothing: the subscriber reads the
 * mark after it. Locally the hint is records-core's store watch (`Store.watchChanges`); hosted, the
 * repository's Durable Object will push each committed append through the same port.
 */
export interface RecordsChanges {
  /**
   * Resolves once the watch is live: every write to the store after it is reported, so a read
   * made after it misses nothing. `changed` may fire for writes that change nothing a reader
   * shows; `failed` fires at most once, after which no change is reported until a new
   * subscription. The result stops the watch. Aborting `signal` before it resolves gives up the
   * watch: it rejects and leaves nothing running.
   */
  readonly subscribe: (
    changed: () => void,
    failed: (error: Error) => void,
    signal?: AbortSignal
  ) => Promise<() => Promise<void>>
}

const inProcess = new Set<() => void>()

/** Tells this process's subscribers that one of its own commands committed (`records.server.ts`). */
export const notifyRecordsChanged = () => {
  for (const changed of inProcess) changed()
}

/** Follows this process's own commits, which need no file-system event. */
export const onRecordsChanged = (changed: () => void) => {
  inProcess.add(changed)
  return () => {
    inProcess.delete(changed)
  }
}

/**
 * The files besides the database and its WAL that the desk shows: the review jobs the worker holds
 * for a missing sign-in (a file, not a database write), relative to the store folder.
 */
export const watchedFiles = (location: StoreLocation) => [
  relative(location.directory, heldReviewsPath(location)),
]

/**
 * The local adapter: records-core's store watch, on the store found when the subscription starts.
 * Its `ready` means live, and it follows the store folder appearing, going or being replaced, and
 * `harness/` appearing after it, reporting one change once the new watches are live. `watchChanges`
 * is the store watch it starts, records-core's unless another with its contract is given.
 */
export const localRecordsChanges = (
  location: () => Promise<StoreLocation>,
  watchChanges: typeof Store.watchChanges = Store.watchChanges
): RecordsChanges => ({
  async subscribe(changed, failed, signal) {
    const at = await location()
    const watch = watchChanges(at, changed, { also: watchedFiles(at) })
    // A closed watch never settles `ready`, so giving up rejects on its own.
    const givenUp = Promise.withResolvers<never>()
    const abandon = () => {
      givenUp.reject(new Error("The Records store watch was given up"))
      void watch.close()
    }
    signal?.addEventListener("abort", abandon, { once: true })
    if (signal?.aborted) abandon()
    try {
      await Promise.race([watch.ready, givenUp.promise])
    } catch (error) {
      await watch.close()
      throw error
    } finally {
      signal?.removeEventListener("abort", abandon)
    }
    // Settles only for a watch that ends without being closed.
    void watch.failed.then(failed)
    return () => watch.close()
  },
})
