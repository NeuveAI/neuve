import { atom, useAtomValueRawSync } from "jotai"
import type { Atom, WritableAtom } from "jotai"
import { atomWithStorage, createJSONStorage } from "jotai/utils"

import { ReviewCommentRecordSchema } from "@workspace/ui/neuve/review-comments/record"
import type {
  ReviewCommentRecord,
  ReviewCommentStatus,
} from "@workspace/ui/neuve/review-comments/record"

/**
 * Where inline review comments live.
 *
 * The interface is a set of jotai atoms so components read and write records
 * the same way regardless of the backing store. Today's implementations are
 * local (browser storage, or memory for stories and tests). A BFF-backed
 * implementation can provide the same atoms on top of server state (for
 * example jotai-tanstack-query) without touching the Review desk.
 */
export interface ReviewCommentRepository {
  /** Every record this store knows about, oldest first. */
  readonly recordsAtom: Atom<ReadonlyArray<ReviewCommentRecord>>
  readonly saveAtom: WritableAtom<null, [record: ReviewCommentRecord], void>
  readonly setStatusAtom: WritableAtom<
    null,
    [id: string, status: ReviewCommentStatus],
    void | Promise<void>
  >
  readonly replaceAtom: WritableAtom<
    null,
    [records: Records, snapshotSequence?: number],
    void
  >
  readonly removeAtom: WritableAtom<null, [id: string], void>
}

// v2: ranges are first-class (schema v2). v1 records are not migrated
// (local development data only).
export const REVIEW_COMMENTS_STORAGE_KEY = "neuve.review-comments.v2"

type Records = ReadonlyArray<ReviewCommentRecord>

function repositoryOver(
  storeAtom: WritableAtom<Records, [Records], void>,
  initialSnapshotSequence?: number
): ReviewCommentRepository {
  const sequenceAtom = atom(initialSnapshotSequence ?? -1)
  return {
    recordsAtom: atom((get) => get(storeAtom)),
    replaceAtom: atom(
      null,
      (get, set, records: Records, snapshotSequence?: number) => {
        if (snapshotSequence !== undefined) {
          if (snapshotSequence < get(sequenceAtom)) return
          set(sequenceAtom, snapshotSequence)
        } else if (get(sequenceAtom) >= 0) return
        set(storeAtom, records)
      }
    ),
    saveAtom: atom(null, (get, set, record: ReviewCommentRecord) => {
      if (record.snapshotSequence !== undefined) {
        const previous = get(storeAtom).find((r) => r.id === record.id)
        if (
          previous?.snapshotSequence !== undefined &&
          previous.snapshotSequence > record.snapshotSequence
        )
          return
        set(sequenceAtom, Math.max(get(sequenceAtom), record.snapshotSequence))
      }
      const rest = get(storeAtom).filter((r) => r.id !== record.id)
      set(storeAtom, [...rest, record])
    }),
    setStatusAtom: atom(
      null,
      (get, set, id: string, status: ReviewCommentStatus) => {
        set(
          storeAtom,
          get(storeAtom).map((r) => (r.id === id ? { ...r, status } : r))
        )
      }
    ),
    removeAtom: atom(null, (get, set, id: string) => {
      set(
        storeAtom,
        get(storeAtom).filter((r) => r.id !== id)
      )
    }),
  }
}

/**
 * Stored records, validated one by one: a record that no longer matches the
 * schema is dropped (and reported) without taking the valid ones with it, so
 * the next save never writes over them.
 */
export function validStoredRecords(value: unknown, fallback: Records): Records {
  if (!Array.isArray(value)) return fallback
  return value.flatMap((item: unknown) => {
    const parsed = ReviewCommentRecordSchema.safeParse(item)
    if (parsed.success) return [parsed.data]
    console.warn("Ignored a stored review comment that is not valid", item)
    return []
  })
}

/**
 * Browser-local repository backed by `atomWithStorage` (localStorage).
 * Stored data is validated on read, record by record; anything that does
 * not match the record schema is ignored rather than trusted. `seed` is
 * what a key that was never written holds (the /mock sample comments); a
 * list the reader emptied stays empty.
 */
export function createLocalReviewCommentRepository(
  key: string = REVIEW_COMMENTS_STORAGE_KEY,
  seed: Records = []
): ReviewCommentRepository {
  // Default JSON storage: localStorage when it exists (never on the server).
  const json = createJSONStorage<Records>()
  const storage = {
    ...json,
    getItem(storageKey: string, initialValue: Records): Records {
      return validStoredRecords(
        json.getItem(storageKey, initialValue),
        initialValue
      )
    },
  }
  // getOnInit stays false: server render and first client render agree (the
  // seed), then the stored records arrive when the atom mounts.
  const storeAtom = atomWithStorage<Records>(key, seed, storage)
  return repositoryOver(
    atom(
      (get) => get(storeAtom),
      (_get, set, next: Records) => set(storeAtom, next)
    )
  )
}

/** In-memory repository (stories, tests): seeded, never persisted. */
export function createMemoryReviewCommentRepository(
  seed: Records = [],
  snapshotSequence?: number
): ReviewCommentRepository {
  return repositoryOver(atom<Records>(seed), snapshotSequence)
}

/**
 * The repository the Review desk uses. Screens get the local one by default;
 * stories hydrate a memory repository (or a story-scoped storage key).
 */
export const defaultReviewCommentRepository: ReviewCommentRepository =
  createLocalReviewCommentRepository()

export const reviewCommentRepositoryAtom = atom<ReviewCommentRepository>(
  defaultReviewCommentRepository
)

/**
 * A repository's records, read through useSyncExternalStore. jotai 3's
 * useAtomValue misses the records the local repository loads from storage on
 * mount unless it is the first reader; server render and hydration see none.
 */
export function useReviewCommentRecords(
  repository: ReviewCommentRepository
): ReadonlyArray<ReviewCommentRecord> {
  return useAtomValueRawSync(repository.recordsAtom)
}
