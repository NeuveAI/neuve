import { beforeEach, expect, test } from "bun:test"
import { createStore } from "jotai"

import {
  agentReviewCommentFixtures,
  mockReviewCommentFixtures,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { createReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import {
  REVIEW_COMMENTS_STORAGE_KEY,
  validStoredRecords,
} from "@workspace/ui/neuve/review-comments/repository"

import {
  MOCK_REVIEW_COMMENTS_STORAGE_KEY,
  mockCommentRepository,
} from "./mock-comments"

/** A minimal browser storage for jotai's JSON storage (Bun has none). */
const backing = new Map<string, string>()
const storage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
}
Object.assign(globalThis, { window: { localStorage: storage } })

beforeEach(() => backing.clear())

/** A desk's store: each unit gets a fresh one (ReviewDeskPage keys it). */
function deskStore() {
  const store = createStore()
  store.sub(mockCommentRepository.recordsAtom, () => {})
  return store
}

test("the sample comments live under their own key", () => {
  expect(MOCK_REVIEW_COMMENTS_STORAGE_KEY).not.toBe(REVIEW_COMMENTS_STORAGE_KEY)
})

test("a key never written holds the seeded people's and agents' comments", () => {
  const store = deskStore()
  expect(store.get(mockCommentRepository.recordsAtom)).toEqual(
    mockReviewCommentFixtures
  )
})

test("a comment written on one unit is still there after switching units", () => {
  const first = deskStore()
  const record = createReviewCommentRecord({
    unitId: agentReviewCommentFixtures[0].unitId,
    revision: agentReviewCommentFixtures[0].revision,
    anchor: agentReviewCommentFixtures[0].anchor,
    author: { id: "you", name: "You", initials: "YO" },
    body: "Read from the primary here too.",
  })
  first.set(mockCommentRepository.saveAtom, record)
  // The next unit's desk: a new store reading the same storage.
  const next = deskStore()
  const ids = next.get(mockCommentRepository.recordsAtom).map((r) => r.id)
  expect(ids).toContain(record.id)
  expect(ids).toHaveLength(mockReviewCommentFixtures.length + 1)
  expect(backing.has(REVIEW_COMMENTS_STORAGE_KEY)).toBe(false)
})

test("an emptied list stays empty (the seed is only for a new key)", () => {
  backing.set(MOCK_REVIEW_COMMENTS_STORAGE_KEY, "[]")
  expect(deskStore().get(mockCommentRepository.recordsAtom)).toEqual([])
})

test("one invalid stored record is skipped; the rest are kept", () => {
  const broken = {
    ...agentReviewCommentFixtures[0],
    id: "rc_broken",
    author: { kind: "agent", id: "i1", name: "I1", initials: "I1" },
  }
  const kept = validStoredRecords(
    [agentReviewCommentFixtures[1], broken, "junk"],
    []
  )
  expect(kept.map((r) => r.id)).toEqual([agentReviewCommentFixtures[1].id])
})
