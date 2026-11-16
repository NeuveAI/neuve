import { mockReviewCommentFixtures } from "@workspace/ui/fixtures/review-batch.fixtures"
import { createLocalReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"

/**
 * Review comments for the `/mock` desk, in browser storage under their own
 * key, so they survive unit switches and reloads (like /mock/settings) and
 * never mix with the real desk's comments. A key that was never written
 * holds the seeded people's and agents' comments, so agent-authored pins
 * (antenna square, ring, raised antenna) show on the first visit.
 *
 * The desk replaces this repository's records only when it has a live
 * decision sink, which `/mock` never passes; keep it that way, or the seed
 * would be replaced with the (empty) fixture snapshot.
 */
export const MOCK_REVIEW_COMMENTS_STORAGE_KEY = "neuve.review-comments.mock.v1"

export const mockCommentRepository = createLocalReviewCommentRepository(
  MOCK_REVIEW_COMMENTS_STORAGE_KEY,
  mockReviewCommentFixtures
)
