/** Comment authors (round 4.2): an optional kind, absent = a person. */
import { describe, expect, test } from "bun:test"

import {
  agentReviewCommentFixtures,
  reviewCommentFixtures,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { reviewCommentToMarker } from "@workspace/ui/neuve/review-comments/markers"
import {
  ReviewCommentRecordListSchema,
  commentThreadAuthor,
} from "@workspace/ui/neuve/review-comments/record"

const stored = JSON.parse(JSON.stringify(reviewCommentFixtures))

describe("ReviewCommentAuthor", () => {
  test("stored v2 records without a kind still parse, as people", () => {
    const parsed = ReviewCommentRecordListSchema.parse(stored)
    expect(parsed.map((record) => record.author.kind)).toEqual(
      reviewCommentFixtures.map(() => undefined)
    )
    expect(reviewCommentToMarker(parsed[0]!).author).toBeUndefined()
    expect(commentThreadAuthor(parsed[0]!.author).kind).toBe("human")
  })

  test("an agent author carries its role onto the marker", () => {
    const parsed = ReviewCommentRecordListSchema.parse(
      JSON.parse(JSON.stringify(agentReviewCommentFixtures))
    )
    expect(reviewCommentToMarker(parsed[1]!).author).toEqual({
      kind: "agent",
      short: "R1",
      role: "reviewer",
      name: "Reviewer 1",
    })
    expect(commentThreadAuthor(parsed[0]!.author)).toEqual({
      kind: "agent",
      agentId: "i1",
      name: "Implementer 1",
      short: "I1",
    })
  })

  test("an agent author without a role is rejected", () => {
    const [record] = JSON.parse(JSON.stringify(agentReviewCommentFixtures))
    delete record.author.role
    expect(ReviewCommentRecordListSchema.safeParse([record]).success).toBe(
      false
    )
  })
})
