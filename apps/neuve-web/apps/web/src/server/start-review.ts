import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"

import { reviewStart, startReview } from "./start-review.server"

/*
 * "Start a review" on the empty overview (M5 ST1–ST4): the overview loads
 * what it would review, or the review it started, and the press is a POST
 * server function behind the CSRF middleware in src/start.ts (ID2), recorded
 * as the person git names (ID1).
 */

const Oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

export const loadStart = createServerFn({ method: "GET" }).handler(
  (): Promise<ReviewStart> => reviewStart()
)

export const requestStart = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      /** The range the overview showed; a moved head or merge base is refused. */
      head: Oid,
      mergeBase: Oid,
    })
  )
  .handler(({ data }) => startReview(data))
