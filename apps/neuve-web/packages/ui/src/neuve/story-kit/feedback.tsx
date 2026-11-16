/**
 * Story kit, feedback (stories only; never imported by product code).
 *
 * Stories record answers with an in-memory sink that answers as Records
 * would: a new event ID per answer.
 */
import type { FeedbackSink } from "@workspace/ui/neuve/review-desk/feedback/atoms"
import type { FeedbackSubmission } from "@workspace/ui/neuve/types"

let sequence = 0

/**
 * An in-memory sink: answers after `delay` ms with a new, later event ID, or
 * refuses with `refuse` as Records' message. `record` sees every submission.
 */
export function storyFeedbackSink({
  delay = 400,
  refuse,
  record,
}: {
  delay?: number
  refuse?: string
  record?: (submission: FeedbackSubmission) => void
} = {}): FeedbackSink {
  return async (submission) => {
    record?.(submission)
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (refuse) throw new Error(refuse)
    sequence += 1
    const {
      target: _target,
      harnessCallVisible: _visible,
      ...answer
    } = submission
    return {
      // Sorts after every fixture ULID, as a newer answer would.
      eventId: `ZZSTORY${String(sequence).padStart(19, "0")}`,
      at: new Date().toISOString(),
      answer,
    }
  }
}
