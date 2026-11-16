import * as React from "react"
import { useRouter } from "@tanstack/react-router"

import type { FeedbackSink } from "@workspace/ui/neuve/review-desk/feedback/atoms"

import { sendFeedback } from "@/server/feedback"

/**
 * The live desk's feedback sink (M5 S7, 10.100): one answer goes to Records
 * through the BFF's command, as the person git names. Once Records has the
 * answer, that is the result: the route's data is read again in the
 * background, and a failed reload never turns a saved answer into an error.
 * A failed call is not retried: it may have appended.
 */
export function useLiveFeedbackSink(): FeedbackSink {
  const router = useRouter()
  return React.useCallback<FeedbackSink>(
    async (submission) => {
      const saved = await sendFeedback({ data: submission })
      router.invalidate().catch((error: unknown) => {
        console.warn(
          "The desk could not reload after feedback was saved",
          error
        )
      })
      return saved
    },
    [router]
  )
}
